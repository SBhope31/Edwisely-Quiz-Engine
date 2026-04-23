import uuid
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from llm import generate_calibration_questions, generate_adaptive_questions, analyze_quiz

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SESSIONS: dict[str, dict] = {}
FIRST_BATCH_SIZE = 2  # Calibration questions


class StartReq(BaseModel):
    topic: str
    weak_areas: str
    num_questions: int = 5


class NextBatchReq(BaseModel):
    session_id: str
    answers_so_far: list[dict]


class SubmitReq(BaseModel):
    session_id: str
    answers: list[dict]
    cheat_events: list[dict] = []


def _sanitize(questions):
    """Patches missing fields AND exposes correct answer + explanation
    so the frontend can show live feedback after each pick.
    (Ok for prototype; in prod you'd reveal via a separate endpoint.)"""
    cleaned = []
    for i, q in enumerate(questions):
        q.setdefault("id", f"q{i+1}")
        q.setdefault("concept", "general")
        q.setdefault("question", "(question text missing)")
        q.setdefault("explanation", "")
        q.setdefault("options", [])
        for opt in q["options"]:
            opt.setdefault("misconception", "unknown")
            opt.setdefault("is_correct", False)

        correct = next((o for o in q["options"] if o["is_correct"]), None)
        cleaned.append({
            "id": q["id"],
            "question": q["question"],
            "concept": q["concept"],
            "explanation": q["explanation"],
            "correct_option_id": correct["id"] if correct else None,
            "options": [
                {
                    "id": o["id"],
                    "text": o["text"],
                    # Include these so frontend can show feedback; fine for prototype
                    "is_correct": o["is_correct"],
                    "misconception": o["misconception"],
                }
                for o in q["options"]
            ],
        })
    return cleaned


@app.post("/api/start")
def start_quiz(req: StartReq):
    if req.num_questions < FIRST_BATCH_SIZE + 2:
        raise HTTPException(400, f"num_questions must be at least {FIRST_BATCH_SIZE + 2}")
    try:
        questions = generate_calibration_questions(
            req.topic, req.weak_areas, n=FIRST_BATCH_SIZE
        )
    except Exception as e:
        raise HTTPException(500, f"Question generation failed: {e}")

    session_id = str(uuid.uuid4())
    SESSIONS[session_id] = {
        "topic": req.topic,
        "weak_areas": req.weak_areas,
        "total_questions": req.num_questions,
        "questions": questions,
    }

    return {
        "session_id": session_id,
        "questions": _sanitize(questions),
        "total_questions": req.num_questions,
        "first_batch_size": FIRST_BATCH_SIZE,
    }


@app.post("/api/next-batch")
def next_batch(req: NextBatchReq):
    session = SESSIONS.get(req.session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    # Grade answers so far
    questions_by_id = {q["id"]: q for q in session["questions"]}
    results = []
    for ans in req.answers_so_far:
        q = questions_by_id.get(ans["question_id"])
        if not q:
            continue
        selected = next(
            (o for o in q["options"] if o["id"] == ans["selected_option_id"]),
            None,
        )
        results.append({
            "question": q["question"],
            "concept": q["concept"],
            "was_correct": bool(selected and selected["is_correct"]),
            "misconception": selected["misconception"] if selected else "unanswered",
        })

    # Decide difficulty direction
    total = len(results)
    correct_count = sum(1 for r in results if r["was_correct"])
    if total == 0 or (0 < correct_count < total):
        direction = "targeted"
    elif correct_count == total:
        direction = "harder"
    else:
        direction = "easier"

    remaining = session["total_questions"] - len(session["questions"])
    try:
        new_questions = generate_adaptive_questions(
            session["topic"],
            session["weak_areas"],
            results,
            direction,
            n=remaining,
            starting_id=len(session["questions"]) + 1,
        )
    except Exception as e:
        raise HTTPException(500, f"Adaptive generation failed: {e}")

    session["questions"].extend(new_questions)

    return {
        "questions": _sanitize(new_questions),
        "difficulty_direction": direction,
    }


@app.post("/api/submit")
def submit_quiz(req: SubmitReq):
    session = SESSIONS.get(req.session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    questions_by_id = {q["id"]: q for q in session["questions"]}
    responses = []
    per_question_feedback = []

    for ans in req.answers:
        q = questions_by_id.get(ans["question_id"])
        if not q:
            continue
        options_by_id = {o["id"]: o for o in q["options"]}
        selected = options_by_id.get(ans["selected_option_id"])
        correct = next(o for o in q["options"] if o["is_correct"])
        is_correct = bool(selected and selected["is_correct"])

        responses.append({
            "question": q["question"],
            "concept": q["concept"],
            "selected_text": selected["text"] if selected else "(no answer)",
            "correct_text": correct["text"],
            "is_correct": is_correct,
            "misconception": selected["misconception"] if selected else "unanswered",
            "time_ms": ans.get("time_ms", 0),
        })
        per_question_feedback.append({
            "question_id": q["id"],
            "question": q["question"],
            "your_answer": selected["text"] if selected else "(no answer)",
            "correct_answer": correct["text"],
            "is_correct": is_correct,
            "misconception": selected["misconception"] if selected else "unanswered",
            "explanation": q["explanation"],
        })

    try:
        analysis = analyze_quiz(session["topic"], session["weak_areas"], responses)
    except Exception as e:
        raise HTTPException(500, f"Analysis failed: {e}")

    tab_switches = sum(1 for e in req.cheat_events if e["type"] == "tab_switch")
    pastes = sum(1 for e in req.cheat_events if e["type"] == "paste")
    cheat_reasons = []
    if tab_switches > 3:
        cheat_reasons.append(f"{tab_switches} tab switches")
    if pastes > 0:
        cheat_reasons.append(f"{pastes} paste events")

    return {
        "per_question": per_question_feedback,
        "analysis": analysis,
        "integrity": {"flagged": bool(cheat_reasons), "reasons": cheat_reasons},
    }


@app.get("/")
def root():
    return {"status": "ok"}