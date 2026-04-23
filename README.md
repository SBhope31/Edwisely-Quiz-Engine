# 🧠 Edwisely Quiz Engine

An adaptive, personalized quiz engine that focuses on **learning through mistakes** — not just evaluation. Students describe what's confusing them, get a targeted quiz that adapts mid-session based on their answers, and receive a deep diagnosis of their mistake patterns with a specific study plan.

**Live demo:** https://edwisely-quiz-engine.vercel.app

> ⚠️ The backend runs on Render's free tier and sleeps after 15 minutes of inactivity. The first quiz generation after idle may take ~30 seconds while the server wakes up. Subsequent requests are fast.

---

## ✨ Features

- **Describe-your-weakness input** — Students enter a topic and describe in free text where they're stuck. The system parses this to target question generation.
- **Adaptive difficulty mid-quiz** — A two-batch flow: 2 calibration questions, then 3+ adaptive questions generated in response to how the student performed.
- **Misconception-tagged distractors** — Every wrong option is tagged at generation time with the specific misconception it represents, so the system knows *why* a student got it wrong.
- **Live inline feedback** — After each answer, correct/incorrect is shown with a concise explanation. No waiting till the end.
- **Mistake-pattern analysis** — On submission, an LLM identifies 1-3 *patterns* (not individual errors), explains the root cause, and gives a specific study plan.
- **Anti-cheat signals** — Tab switches, paste events, and copy attempts are logged and flagged in the report.
- **Clean, modern UI** — Glassmorphism, gradient accents, animated transitions, keyboard shortcuts (`1`-`4` to pick, `←`/`→` to navigate).

---

## 🏗️ Architecture

```
┌─────────────┐      REST       ┌──────────────┐    Groq API    ┌──────────────────┐
│   React     │ ──────────────► │   FastAPI    │ ─────────────► │ Llama 3.3 70B    │
│  (Vercel)   │ ◄────────────── │   (Render)   │ ◄───────────── │  (Groq)          │
└─────────────┘                 └──────────────┘                └──────────────────┘
                                       │
                                       └── In-memory session store
```

**Stack**

| Layer | Tech |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS, Recharts |
| Backend | FastAPI, Pydantic, Uvicorn |
| LLM | Groq (`llama-3.3-70b-versatile`) |
| Hosting | Vercel (frontend), Render (backend) |

---

## 🎯 Core Design Decisions

### 1. Misconception-tagged distractors
Every wrong option in every MCQ is tagged at generation time (e.g., `off_by_one_error`, `confuses_state_with_choice`). When the student picks a wrong option, the system knows **why** they're wrong without post-hoc guessing. This drives the entire analysis pipeline.

### 2. Two-batch adaptive generation
Questions are not generated all at once. The flow is:

1. **Calibration batch** — 2 medium-difficulty diagnostic questions
2. **Adaptive batch** — remaining questions generated *after* seeing calibration results

Based on calibration performance, the backend picks one of three directions:

| Result | Direction | Next Questions |
|---|---|---|
| All correct | `harder` | Edge cases, traps, multi-concept combinations |
| All wrong | `easier` | Foundational, direct, confidence-building |
| Mixed | `targeted` | Specifically confront the demonstrated misconceptions |

### 3. Pattern analysis over grading
The final LLM call receives all wrong answers with their misconception tags and returns **patterns** — not a list of individual errors. Each pattern includes a root cause, supporting evidence, and concrete how-to-fix steps. No generic "practice more" advice.

### 4. Live feedback
Students see correct/incorrect plus an explanation immediately after each answer. Reinforces learning while the question is still fresh in their mind.

---

## 🛡️ Anti-Cheating Approach

- **Uniquely generated quizzes** — Every session gets LLM-generated questions; no two students receive identical questions, eliminating answer-sharing.
- **Behavioral signals** — Tab switches, paste events, copy attempts, and per-question timing are all logged.
- **Copy blocking** — Question text cannot be copied, making it harder to paste into external LLMs.
- **Integrity report** — Suspicious activity is flagged in the final report with specific reasons.

---

## 📂 Project Structure

```
edwisely-quiz-engine/
├── backend/
│   ├── main.py              # FastAPI app, API endpoints, sanitization
│   ├── llm.py               # Groq prompts: calibration, adaptive, analysis
│   ├── requirements.txt
│   └── .env                 # (not committed — contains GROQ_API_KEY)
├── frontend/
│   ├── src/
│   │   ├── App.jsx          # Full quiz engine UI
│   │   ├── index.css        # Tailwind + custom animations/glass styles
│   │   └── main.jsx
│   ├── package.json
│   └── .env.local           # (not committed — contains VITE_API_URL)
├── .gitignore
└── README.md
```

---

## 🔌 API Reference

### `POST /api/start`
Starts a quiz session and returns calibration questions.
```json
Request:
{
  "topic": "Dynamic Programming",
  "weak_areas": "I can't figure out state definition in 2D DP problems",
  "num_questions": 5
}

Response:
{
  "session_id": "uuid",
  "questions": [...],
  "total_questions": 5,
  "first_batch_size": 2
}
```

### `POST /api/next-batch`
Generates the adaptive batch based on calibration performance.
```json
Request:
{
  "session_id": "uuid",
  "answers_so_far": [
    { "question_id": "q1", "selected_option_id": "b", "time_ms": 8500 }
  ]
}

Response:
{
  "questions": [...],
  "difficulty_direction": "harder" | "easier" | "targeted"
}
```

### `POST /api/submit`
Grades the quiz and returns pattern analysis.
```json
Request:
{
  "session_id": "uuid",
  "answers": [...],
  "cheat_events": [{ "type": "tab_switch", "timestamp": 1234567890 }]
}

Response:
{
  "per_question": [...],
  "analysis": {
    "score": "3/5",
    "summary": "...",
    "patterns": [{ "name": "...", "root_cause": "...", "how_to_fix": [...] }],
    "next_topics": [...]
  },
  "integrity": { "flagged": false, "reasons": [] }
}
```

---

## 🚀 Run Locally

### Prerequisites
- Python 3.10+
- Node.js 18+
- A free [Groq API key](https://console.groq.com/keys)

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate         # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Create .env file:
echo "GROQ_API_KEY=your_key_here" > .env

uvicorn main:app --reload --port 8000
```

### Frontend
```bash
cd frontend
npm install

# Create .env.local:
echo "VITE_API_URL=http://localhost:8000" > .env.local

npm run dev
```

Open http://localhost:5173

---

## 🎨 UX Details

- **Keyboard-first** — `1`-`4` to pick options, `←`/`→` to navigate, `Enter` to continue/submit
- **Per-question + total timer** visible at all times
- **Progress rail** — green (correct), red (wrong), grey (unanswered), dashed (not yet generated)
- **Animated toast** when difficulty adapts between batches
- **Collapsible question review** in the final report

---

## ⚖️ Trade-offs for Prototype Scope

| Compromise | Production version would use |
|---|---|
| In-memory session store | PostgreSQL / Redis |
| Open CORS | Locked to frontend domain |
| No user auth | OAuth / session tokens |
| Single-shot adaptive split (2→3) | Per-question IRT-based adaptation |
| Client-side correct-answer reveal | Secure server-side reveal endpoint |
| No question bank / caching | Pre-computed question bank by concept + difficulty |

---

## 📄 License

MIT — feel free to fork and build on it.

---

## 🙋 Author

Built as a take-home assignment for **Edwisely**.
