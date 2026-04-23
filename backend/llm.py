import os
import json
from groq import Groq
from dotenv import load_dotenv

load_dotenv()
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# Fast, free, smart enough for a prototype
MODEL = "llama-3.3-70b-versatile"


def _call(prompt: str) -> str:
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
        response_format={"type": "json_object"},  # forces JSON
    )
    return resp.choices[0].message.content


def _extract_json(text: str):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text.strip())


def _unwrap_questions(data):
    """Groq's json_object mode returns an object. Unwrap to a list of questions."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("questions", [])
    return []


def generate_calibration_questions(topic: str, weak_areas: str, n: int = 2) -> list[dict]:
    """Batch 1: medium-difficulty diagnostic questions to gauge skill level."""
    ids = ", ".join(f"q{i+1}" for i in range(n))

    prompt = f"""Generate {n} CALIBRATION multiple-choice questions on "{topic}".

Student's stated weak areas:
"{weak_areas}"

These are the FIRST questions — used to calibrate the student's skill level
before adapting the rest of the quiz. Keep difficulty at MEDIUM level.
Make them genuinely diagnostic — each should clearly distinguish whether
the student has or lacks a specific sub-skill.

CRITICAL — every question MUST include ALL of these fields exactly:
- id (use: {ids})
- question (the question text)
- concept (the specific sub-concept tested — REQUIRED, never omit)
- options (array of exactly 4 options)
- explanation (explanation of the correct answer — REQUIRED, never omit)

Each option MUST include:
- id ("a", "b", "c", or "d")
- text
- misconception (the specific misconception tag like "off_by_one_error",
  or "correct" for the right answer)
- is_correct (true for exactly ONE option, false for the others)

Requirements:
1. Each question must PROBE one of their stated weak areas.
2. 4 options per question. Exactly ONE correct.
3. Every wrong option tagged with the specific misconception.

Return ONLY JSON in this EXACT shape:
{{
  "questions": [
    {{
      "id": "q1",
      "question": "...",
      "concept": "specific sub-concept tested",
      "options": [
        {{"id": "a", "text": "...", "misconception": "...", "is_correct": false}},
        {{"id": "b", "text": "...", "misconception": "correct", "is_correct": true}},
        {{"id": "c", "text": "...", "misconception": "...", "is_correct": false}},
        {{"id": "d", "text": "...", "misconception": "...", "is_correct": false}}
      ],
      "explanation": "..."
    }}
  ]
}}"""
    return _unwrap_questions(_extract_json(_call(prompt)))


def generate_adaptive_questions(topic, weak_areas, past_results, direction, n, starting_id):
    """Batch 2: adaptive questions based on performance in batch 1."""
    history = "\n".join(
        f"- Q: {r['question']}\n"
        f"  Concept: {r['concept']}\n"
        f"  Result: {'CORRECT' if r['was_correct'] else 'WRONG (misconception: ' + r['misconception'] + ')'}"
        for r in past_results
    )

    direction_prompt = {
        "harder": (
            "The student got EVERYTHING right so far. Make these questions noticeably HARDER: "
            "test edge cases, tricky applications, common pitfalls, and scenarios that require "
            "combining multiple concepts."
        ),
        "easier": (
            "The student got EVERYTHING wrong so far. Make these questions EASIER: "
            "focus on foundational understanding. Use direct, concrete probes. "
            "Avoid trick wording. Help them succeed while still testing the concept."
        ),
        "targeted": (
            "The student got a mix right and wrong. Keep similar difficulty, but DIRECTLY TARGET "
            "the misconceptions they demonstrated. Design questions that force them to confront "
            "and resolve those SPECIFIC misunderstandings, not just questions on the same topic."
        ),
    }[direction]

    ids = ", ".join(f"q{starting_id + i}" for i in range(n))

    prompt = f"""Generate {n} MORE multiple-choice questions on "{topic}".
Student's stated weak areas: "{weak_areas}"

Their performance on the first {len(past_results)} questions:
{history}

{direction_prompt}

CRITICAL — every question MUST include ALL of these fields exactly:
- id (use: {ids})
- question (the question text)
- concept (the specific sub-concept tested — REQUIRED, never omit)
- options (array of exactly 4 options)
- explanation (explanation of the correct answer — REQUIRED, never omit)

Each option MUST include:
- id ("a", "b", "c", or "d")
- text
- misconception (specific misconception tag, or "correct" for the right answer)
- is_correct (true for exactly ONE option, false for the others)

Vary the framing/context from the calibration questions — don't rephrase them.

Return ONLY JSON in this EXACT shape:
{{
  "questions": [
    {{
      "id": "q{starting_id}",
      "question": "...",
      "concept": "specific sub-concept",
      "options": [
        {{"id": "a", "text": "...", "misconception": "...", "is_correct": false}},
        {{"id": "b", "text": "...", "misconception": "correct", "is_correct": true}},
        {{"id": "c", "text": "...", "misconception": "...", "is_correct": false}},
        {{"id": "d", "text": "...", "misconception": "...", "is_correct": false}}
      ],
      "explanation": "..."
    }}
  ]
}}"""
    return _unwrap_questions(_extract_json(_call(prompt)))


def analyze_quiz(topic: str, weak_areas: str, responses: list[dict]) -> dict:
    wrong = [r for r in responses if not r["is_correct"]]
    correct = [r for r in responses if r["is_correct"]]

    wrong_summary = "\n".join(
        f"- Q: {r['question']}\n  Picked: {r['selected_text']} "
        f"(misconception: {r['misconception']})\n  Correct was: {r['correct_text']}\n"
        f"  Concept: {r['concept']} | Time: {r['time_ms']}ms"
        for r in wrong
    ) or "(none — student got everything right)"

    correct_summary = ", ".join(r["concept"] for r in correct) or "(none)"

    prompt = f"""A student studied "{topic}" and said their weak areas were:
"{weak_areas}"

Quiz WRONG answers:
{wrong_summary}

Concepts they got RIGHT: {correct_summary}

Identify 1-3 mistake PATTERNS (not individual errors). For each, explain the
underlying misunderstanding and give specific, actionable study steps.
No generic advice like "practice more".

Return ONLY JSON in this EXACT shape:
{{
  "score": "{len(correct)}/{len(responses)}",
  "summary": "2-3 sentence diagnosis",
  "patterns": [
    {{
      "name": "short pattern name",
      "root_cause": "what's broken in their mental model",
      "evidence": "which questions show this",
      "how_to_fix": ["specific step 1", "specific step 2", "specific step 3"]
    }}
  ],
  "next_topics": ["concrete topic to study next", "another topic"]
}}"""
    return _extract_json(_call(prompt))