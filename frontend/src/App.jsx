import { useState, useEffect, useRef, useCallback } from "react";
import axios from "axios";
import {
  PieChart, Pie, Cell, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";

const API = (import.meta.env.VITE_API_URL || "http://localhost:8000") + "/api";

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
};

export default function App() {
  const [stage, setStage] = useState("setup");
  const [topic, setTopic] = useState("");
  const [weakAreas, setWeakAreas] = useState("");
  const [numQ, setNumQ] = useState(5);

  const [sessionId, setSessionId] = useState("");
  const [questions, setQuestions] = useState([]);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [firstBatchSize, setFirstBatchSize] = useState(2);

  const [answers, setAnswers] = useState({});      // { qid: { selected_option_id, time_ms } }
  const [locked, setLocked] = useState({});        // { qid: true }  ← live-feedback flag
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loadingBatch, setLoadingBatch] = useState(false);
  const [difficultyToast, setDifficultyToast] = useState(null);

  const [report, setReport] = useState(null);

  // Timers
  const [totalElapsed, setTotalElapsed] = useState(0);
  const quizStartRef = useRef(0);
  const questionStartRef = useRef(Date.now());
  const cheatEvents = useRef([]);

  // ---- Timer tick ----
  useEffect(() => {
    if (stage !== "quiz") return;
    const iv = setInterval(() => {
      setTotalElapsed(Date.now() - quizStartRef.current);
    }, 500);
    return () => clearInterval(iv);
  }, [stage]);

  // ---- Anti-cheat listeners ----
  useEffect(() => {
    if (stage !== "quiz") return;
    const onVis = () => {
      if (document.hidden) cheatEvents.current.push({ type: "tab_switch", timestamp: Date.now() });
    };
    const onPaste = () => cheatEvents.current.push({ type: "paste", timestamp: Date.now() });
    const onCopy = (e) => {
      e.preventDefault();
      cheatEvents.current.push({ type: "copy_blocked", timestamp: Date.now() });
    };
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("paste", onPaste);
    document.addEventListener("copy", onCopy);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("copy", onCopy);
    };
  }, [stage]);

  // Reset per-question timer
  useEffect(() => {
    questionStartRef.current = Date.now();
  }, [currentIdx]);

  // ---- API actions ----
  const startQuiz = async () => {
    if (!topic.trim() || !weakAreas.trim()) {
      alert("Please fill in both fields");
      return;
    }
    setStage("loading");
    try {
      const { data } = await axios.post(`${API}/start`, {
        topic, weak_areas: weakAreas, num_questions: numQ,
      });
      setSessionId(data.session_id);
      setQuestions(data.questions);
      setTotalQuestions(data.total_questions);
      setFirstBatchSize(data.first_batch_size);
      setAnswers({});
      setLocked({});
      setCurrentIdx(0);
      cheatEvents.current = [];
      quizStartRef.current = Date.now();
      setTotalElapsed(0);
      setStage("quiz");
    } catch (e) {
      alert("Failed: " + (e.response?.data?.detail || e.message));
      setStage("setup");
    }
  };

  const pickOption = useCallback((qid, oid) => {
    if (locked[qid]) return; // Already answered
    const timeTaken = Date.now() - questionStartRef.current;
    setAnswers((prev) => ({ ...prev, [qid]: { selected_option_id: oid, time_ms: timeTaken } }));
    setLocked((prev) => ({ ...prev, [qid]: true }));
  }, [locked]);

  const loadNextBatch = async () => {
    setLoadingBatch(true);
    try {
      const answersSoFar = questions.map((q) => ({
        question_id: q.id,
        selected_option_id: answers[q.id]?.selected_option_id || "",
        time_ms: answers[q.id]?.time_ms || 0,
      }));
      const { data } = await axios.post(`${API}/next-batch`, {
        session_id: sessionId, answers_so_far: answersSoFar,
      });
      const nextIdx = questions.length;
      setQuestions((prev) => [...prev, ...data.questions]);
      setCurrentIdx(nextIdx);
      const toasts = {
        harder: "🔥 Acing it — cranking up the difficulty",
        easier: "🌱 Let's build a stronger foundation",
        targeted: "🎯 Zeroing in on your misconceptions",
      };
      setDifficultyToast(toasts[data.difficulty_direction]);
      setTimeout(() => setDifficultyToast(null), 4000);
    } catch (e) {
      alert("Failed to load next questions: " + (e.response?.data?.detail || e.message));
    } finally {
      setLoadingBatch(false);
    }
  };

  const goNext = useCallback(() => {
    const isLastLoaded = currentIdx === questions.length - 1;
    const hasMore = questions.length < totalQuestions;
    if (isLastLoaded && hasMore) loadNextBatch();
    else if (currentIdx < totalQuestions - 1) setCurrentIdx((i) => i + 1);
  }, [currentIdx, questions.length, totalQuestions]);

  const goBack = useCallback(() => {
    setCurrentIdx((i) => Math.max(0, i - 1));
  }, []);

  const submitQuiz = async () => {
    if (Object.keys(answers).length < totalQuestions) {
      if (!confirm("Some questions are unanswered. Submit anyway?")) return;
    }
    setStage("loading");
    try {
      const { data } = await axios.post(`${API}/submit`, {
        session_id: sessionId,
        answers: questions.map((q) => ({
          question_id: q.id,
          selected_option_id: answers[q.id]?.selected_option_id || "",
          time_ms: answers[q.id]?.time_ms || 0,
        })),
        cheat_events: cheatEvents.current,
      });
      setReport(data);
      setStage("report");
    } catch (e) {
      alert("Submit failed: " + (e.response?.data?.detail || e.message));
      setStage("quiz");
    }
  };

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    if (stage !== "quiz" || loadingBatch) return;
    const onKey = (e) => {
      const q = questions[currentIdx];
      if (!q) return;
      // Ignore when user is typing in inputs
      if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
      if (["1", "2", "3", "4"].includes(e.key)) {
        const opt = q.options[parseInt(e.key) - 1];
        if (opt) pickOption(q.id, opt.id);
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        if (currentIdx === totalQuestions - 1 && questions.length === totalQuestions) {
          // Last question — let Enter submit only if all answered
          if (e.key === "Enter" && Object.keys(answers).length === totalQuestions) submitQuiz();
        } else {
          goNext();
        }
      } else if (e.key === "ArrowLeft") {
        goBack();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [stage, loadingBatch, currentIdx, questions, pickOption, goNext, goBack, answers, totalQuestions]);

  const reset = () => {
    setStage("setup");
    setTopic(""); setWeakAreas("");
    setReport(null);
  };

  // ================= RENDER =================
  return (
    <div className="bg-orbs min-h-screen relative">
      <div className="relative z-10">
        {stage === "loading" && <LoadingScreen />}
        {stage === "setup" && (
          <SetupScreen
            topic={topic} setTopic={setTopic}
            weakAreas={weakAreas} setWeakAreas={setWeakAreas}
            numQ={numQ} setNumQ={setNumQ}
            onStart={startQuiz}
          />
        )}
        {stage === "quiz" && (
          <QuizScreen
            questions={questions}
            totalQuestions={totalQuestions}
            firstBatchSize={firstBatchSize}
            currentIdx={currentIdx}
            setCurrentIdx={setCurrentIdx}
            answers={answers}
            locked={locked}
            pickOption={pickOption}
            goNext={goNext}
            goBack={goBack}
            submitQuiz={submitQuiz}
            loadingBatch={loadingBatch}
            difficultyToast={difficultyToast}
            totalElapsed={totalElapsed}
            questionStartRef={questionStartRef}
          />
        )}
        {stage === "report" && <ReportScreen report={report} totalElapsed={totalElapsed} onReset={reset} />}
      </div>
    </div>
  );
}

// ============================================================
// SETUP SCREEN
// ============================================================
function SetupScreen({ topic, setTopic, weakAreas, setWeakAreas, numQ, setNumQ, onStart }) {
  return (
    <div className="min-h-screen flex items-center justify-center py-12 px-4">
      <div className="max-w-2xl w-full animate-fadeUp">
        <div className="text-center mb-8">
          <div className="inline-block px-4 py-1.5 rounded-full bg-gradient-to-r from-indigo-100 to-purple-100 text-indigo-700 text-xs font-semibold tracking-wide mb-4">
            ✨ ADAPTIVE LEARNING
          </div>
          <h1 className="text-5xl font-bold bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 bg-clip-text text-transparent">
            Quiz that learns<br />from your mistakes
          </h1>
          <p className="text-slate-600 mt-4 max-w-lg mx-auto">
            Tell us what's confusing you. We'll calibrate, adapt, and diagnose exactly where you're stuck.
          </p>
        </div>

        <div className="glass rounded-2xl shadow-xl p-8 space-y-5">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              What are you studying?
            </label>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. Dynamic Programming, React Hooks, Thermodynamics..."
              className="w-full bg-white/60 border border-slate-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              Where are you stuck? <span className="text-slate-400 font-normal">(be specific)</span>
            </label>
            <textarea
              value={weakAreas}
              onChange={(e) => setWeakAreas(e.target.value)}
              rows={4}
              placeholder="e.g. I can't figure out the state definition in 2D DP problems, and I'm confused about when to use top-down vs bottom-up..."
              className="w-full bg-white/60 border border-slate-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition resize-none"
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-sm font-semibold text-slate-700">Questions</label>
              <span className="text-sm text-indigo-600 font-mono font-semibold">
                {numQ}
              </span>
            </div>
            <input
              type="range" min="4" max="10" value={numQ}
              onChange={(e) => setNumQ(+e.target.value)}
              className="w-full"
            />
          </div>

          <button
            onClick={onStart}
            className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-semibold py-4 rounded-xl shadow-lg shadow-indigo-500/30 hover:shadow-xl hover:shadow-indigo-500/40 transition-all transform hover:-translate-y-0.5"
          >
            Generate My Quiz →
          </button>
        </div>

        <p className="text-center text-xs text-slate-500 mt-6">
          💡 Tip: Use <kbd>1</kbd>–<kbd>4</kbd> to pick • <kbd>←</kbd><kbd>→</kbd> to navigate • <kbd>Enter</kbd> to continue
        </p>
      </div>
    </div>
  );
}

// ============================================================
// LOADING SCREEN
// ============================================================
function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center animate-fadeUp">
        <div className="relative inline-block">
          <div className="animate-spin h-16 w-16 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
          <div className="absolute inset-0 animate-ping h-16 w-16 border-4 border-purple-400 border-t-transparent rounded-full opacity-30"></div>
        </div>
        <p className="mt-6 text-slate-700 font-medium">Thinking...</p>
      </div>
    </div>
  );
}

// ============================================================
// QUIZ SCREEN
// ============================================================
function QuizScreen({
  questions, totalQuestions, firstBatchSize, currentIdx, setCurrentIdx,
  answers, locked, pickOption, goNext, goBack, submitQuiz,
  loadingBatch, difficultyToast, totalElapsed, questionStartRef,
}) {
  const q = questions[currentIdx];
  const sel = answers[q?.id]?.selected_option_id;
  const isLocked = !!locked[q?.id];
  const isLast = currentIdx === totalQuestions - 1 && questions.length === totalQuestions;
  const isCalib = currentIdx < firstBatchSize;
  const answeredCount = Object.keys(answers).length;

  const [qTimer, setQTimer] = useState(0);
  useEffect(() => {
    if (isLocked) return;
    const iv = setInterval(() => setQTimer(Date.now() - questionStartRef.current), 250);
    return () => clearInterval(iv);
  }, [isLocked, currentIdx, questionStartRef]);
  useEffect(() => { setQTimer(0); }, [currentIdx]);

  if (loadingBatch) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="glass rounded-2xl p-10 max-w-md text-center animate-pop shadow-xl">
          <div className="relative inline-block mb-4">
            <div className="animate-spin h-14 w-14 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
          </div>
          <h3 className="text-xl font-bold text-slate-800">Analyzing your answers</h3>
          <p className="text-slate-600 mt-2 text-sm">
            Generating questions targeted at your specific misconceptions...
          </p>
          <div className="mt-4 flex gap-1.5 justify-center">
            {["Reading", "Diagnosing", "Generating"].map((s, i) => (
              <div key={s} className="px-2 py-1 text-xs rounded-full bg-indigo-100 text-indigo-700"
                   style={{ animation: `fadeUp 0.4s ${i * 0.3}s both` }}>
                {s}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!q) return null;

  return (
    <div className="min-h-screen py-6 px-4">
      {difficultyToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-5 py-3 rounded-xl shadow-2xl animate-pop font-medium">
          {difficultyToast}
        </div>
      )}

      <div className="max-w-3xl mx-auto">
        {/* Top bar */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
              isCalib
                ? "bg-blue-100 text-blue-700"
                : "bg-gradient-to-r from-indigo-100 to-purple-100 text-indigo-700"
            }`}>
              {isCalib ? "📊 Calibration" : "🎯 Adaptive"}
            </span>
            <span className="text-sm text-slate-600">
              Q<span className="font-bold text-slate-800">{currentIdx + 1}</span> / {totalQuestions}
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <div className="flex items-center gap-1.5 text-slate-600">
              <span className="text-lg">⏱</span>
              <span className="font-mono">
                {isLocked ? fmtTime(answers[q.id]?.time_ms || 0) : fmtTime(qTimer)}
              </span>
            </div>
            <div className="text-slate-400 font-mono text-xs">
              total {fmtTime(totalElapsed)}
            </div>
          </div>
        </div>

        {/* Progress rail */}
        <div className="flex gap-1.5 mb-6">
          {Array.from({ length: totalQuestions }).map((_, i) => {
            const loaded = i < questions.length;
            const answered = loaded && answers[questions[i].id];
            const isWrong = answered && !questions[i].options.find(o => o.id === answers[questions[i].id].selected_option_id)?.is_correct;
            const isCurrent = i === currentIdx;
            return (
              <button
                key={i}
                onClick={() => loaded && setCurrentIdx(i)}
                disabled={!loaded}
                className={`flex-1 h-1.5 rounded-full transition-all ${
                  isCurrent
                    ? "bg-gradient-to-r from-indigo-600 to-purple-600 h-2"
                    : answered
                      ? isWrong ? "bg-rose-400" : "bg-emerald-400"
                      : loaded
                        ? "bg-slate-300"
                        : "bg-slate-200 opacity-50"
                }`}
              />
            );
          })}
        </div>

        {/* Question card */}
        <div key={q.id} className="glass rounded-2xl shadow-xl p-8 animate-fadeUp">
          <div className="flex justify-between items-start mb-5">
            <span className="text-xs uppercase tracking-wider text-slate-400 font-semibold">
              {q.concept}
            </span>
          </div>

          <h2 className="text-2xl font-semibold text-slate-900 leading-relaxed select-none">
            {q.question}
          </h2>

          <div className="mt-6 space-y-3">
            {q.options.map((opt, idx) => {
              const picked = sel === opt.id;
              const isCorrect = opt.id === q.correct_option_id;
              let styles = "border-slate-200 hover:border-indigo-400 hover:bg-white/50";
              let badge = null;
              if (isLocked) {
                if (isCorrect) {
                  styles = "border-emerald-500 bg-emerald-50/70";
                  badge = <span className="text-emerald-600 text-xl">✓</span>;
                } else if (picked) {
                  styles = "border-rose-500 bg-rose-50/70";
                  badge = <span className="text-rose-600 text-xl">✗</span>;
                } else {
                  styles = "border-slate-200 opacity-50";
                }
              } else if (picked) {
                styles = "border-indigo-600 bg-indigo-50/70 shadow-lg";
              }

              return (
                <button
                  key={opt.id}
                  onClick={() => pickOption(q.id, opt.id)}
                  disabled={isLocked}
                  className={`w-full text-left border-2 rounded-xl px-4 py-3.5 transition-all flex items-center gap-3 ${styles} ${
                    isLocked ? "cursor-default" : "cursor-pointer"
                  }`}
                >
                  <kbd className="flex-shrink-0">{idx + 1}</kbd>
                  <span className="flex-1 text-slate-800">{opt.text}</span>
                  {badge}
                </button>
              );
            })}
          </div>

          {/* Live feedback */}
          {isLocked && (
            <div
              className={`mt-5 rounded-xl p-4 border animate-fadeUp ${
                q.options.find(o => o.id === sel)?.is_correct
                  ? "bg-emerald-50/70 border-emerald-200"
                  : "bg-rose-50/70 border-rose-200"
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl">
                  {q.options.find(o => o.id === sel)?.is_correct ? "🎉" : "💡"}
                </span>
                <div>
                  <p className="font-semibold text-slate-800">
                    {q.options.find(o => o.id === sel)?.is_correct ? "Nice!" : "Not quite."}
                  </p>
                  <p className="text-sm text-slate-700 mt-1">{q.explanation}</p>
                </div>
              </div>
            </div>
          )}

          {/* Nav */}
          <div className="mt-7 flex justify-between items-center">
            <button
              onClick={goBack}
              disabled={currentIdx === 0}
              className="px-5 py-2.5 rounded-xl border border-slate-300 bg-white/60 hover:bg-white disabled:opacity-30 transition flex items-center gap-1.5"
            >
              <span>←</span>
              <kbd>←</kbd>
            </button>
            <span className="text-xs text-slate-400 hidden sm:inline">
              <kbd>1</kbd>-<kbd>4</kbd> pick • <kbd>Enter</kbd> continue
            </span>
            {isLast ? (
              <button
                onClick={submitQuiz}
                className="px-6 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-semibold rounded-xl shadow-lg shadow-emerald-500/30 hover:shadow-xl transition flex items-center gap-2"
              >
                Submit ({answeredCount}/{totalQuestions})
              </button>
            ) : (
              <button
                onClick={goNext}
                className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold rounded-xl shadow-lg shadow-indigo-500/30 hover:shadow-xl transition flex items-center gap-1.5"
              >
                <kbd className="!bg-white/20 !text-white !border-white/30">→</kbd>
                <span>Next</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// REPORT SCREEN
// ============================================================
function ReportScreen({ report, totalElapsed, onReset }) {
  const { per_question, analysis, integrity } = report;
  const correct = per_question.filter((p) => p.is_correct).length;
  const total = per_question.length;
  const pct = Math.round((correct / total) * 100);
  const uniqueMisc = new Set(per_question.filter(p => !p.is_correct).map(p => p.misconception)).size;

  const donutData = [
    { name: "Correct", value: correct, color: "#10b981" },
    { name: "Wrong", value: total - correct, color: "#f43f5e" },
  ];


  return (
    <div className="min-h-screen py-8 px-4">
      <div className="max-w-4xl mx-auto space-y-6 animate-fadeUp">
        {/* Hero */}
        <div className="glass rounded-3xl shadow-2xl p-8 md:p-10">
          <div className="flex flex-col md:flex-row items-center gap-8">
            <div className="relative w-48 h-48 flex-shrink-0">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="value"
                    innerRadius={60}
                    outerRadius={85}
                    startAngle={90}
                    endAngle={-270}
                    stroke="none"
                  >
                    {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <div className="text-4xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                  {pct}%
                </div>
                <div className="text-sm text-slate-500">{correct}/{total}</div>
              </div>
            </div>

            <div className="flex-1 text-center md:text-left">
              <div className="inline-block px-3 py-1 rounded-full bg-gradient-to-r from-indigo-100 to-purple-100 text-indigo-700 text-xs font-semibold mb-3">
                📊 YOUR REPORT
              </div>
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
                {pct >= 80 ? "Strong performance" : pct >= 50 ? "Good effort — gaps found" : "Important gaps to fix"}
              </h1>
              <p className="text-slate-600 mt-3">{analysis.summary}</p>

              {integrity.flagged && (
                <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 inline-flex items-center gap-2">
                  <span>⚠️</span> Integrity flags: {integrity.reasons.join(", ")}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard label="Total time" value={fmtTime(totalElapsed)} icon="⏱" />
          <StatCard label="Accuracy" value={`${pct}%`} icon="🎯" />
          <StatCard label="Unique misconceptions" value={uniqueMisc} icon="🧠" />
        </div>


        {/* Mistake patterns */}
        <div className="glass rounded-2xl shadow-xl p-6">
          <h2 className="text-2xl font-bold text-slate-800 mb-4">
            🧩 Mistake Patterns
          </h2>
          <div className="space-y-4">
            {analysis.patterns.map((p, i) => (
              <div key={i} className="border border-slate-200 rounded-xl p-5 bg-white/50">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-white font-bold flex items-center justify-center text-sm">
                    {i + 1}
                  </div>
                  <div className="flex-1">
                    <h3 className="font-bold text-slate-900">{p.name}</h3>
                    <p className="text-sm text-slate-700 mt-2">
                      <span className="font-semibold text-indigo-700">Root cause:</span> {p.root_cause}
                    </p>
                    <p className="text-sm text-slate-500 mt-1">
                      <span className="font-semibold">Evidence:</span> {p.evidence}
                    </p>
                    <div className="mt-3 bg-indigo-50/70 rounded-lg p-3">
                      <p className="text-xs font-semibold text-indigo-700 mb-2">HOW TO FIX</p>
                      <ul className="space-y-1.5">
                        {p.how_to_fix.map((step, j) => (
                          <li key={j} className="text-sm text-slate-700 flex gap-2">
                            <span className="text-indigo-500 font-bold">→</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {analysis.next_topics?.length > 0 && (
            <div className="mt-5 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-5 border border-indigo-100">
              <h3 className="font-bold text-indigo-900 flex items-center gap-2">
                📚 Study these next
              </h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {analysis.next_topics.map((t, i) => (
                  <span key={i} className="px-3 py-1.5 bg-white text-sm text-indigo-700 rounded-full border border-indigo-200 font-medium">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Question review */}
        <div className="glass rounded-2xl shadow-xl p-6">
          <h2 className="text-2xl font-bold text-slate-800 mb-4">Question Review</h2>
          <div className="space-y-3">
            {per_question.map((p, i) => (
              <details key={p.question_id}
                className={`group rounded-xl border-l-4 ${p.is_correct ? "border-emerald-500 bg-emerald-50/40" : "border-rose-500 bg-rose-50/40"} overflow-hidden`}>
                <summary className="cursor-pointer px-4 py-3 flex items-center justify-between hover:bg-white/40 transition">
                  <span className="font-medium text-slate-800 flex items-center gap-2">
                    <span className={p.is_correct ? "text-emerald-600" : "text-rose-600"}>
                      {p.is_correct ? "✓" : "✗"}
                    </span>
                    Q{i + 1}. {p.question.substring(0, 80)}{p.question.length > 80 ? "..." : ""}
                  </span>
                  <span className="text-slate-400 group-open:rotate-180 transition">▾</span>
                </summary>
                <div className="px-4 pb-4 space-y-2 text-sm">
                  <p>Your answer: <span className={p.is_correct ? "text-emerald-700 font-medium" : "text-rose-700 font-medium"}>{p.your_answer}</span></p>
                  {!p.is_correct && (
                    <>
                      <p>Correct: <span className="text-emerald-700 font-medium">{p.correct_answer}</span></p>
                      <p className="text-xs text-slate-500">
                        Misconception: <code className="bg-slate-100 px-1.5 py-0.5 rounded text-indigo-700">{p.misconception}</code>
                      </p>
                    </>
                  )}
                  <p className="text-slate-700 bg-white/70 p-3 rounded-lg mt-2">💡 {p.explanation}</p>
                </div>
              </details>
            ))}
          </div>
        </div>

        <button
          onClick={onReset}
          className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-semibold py-4 rounded-xl shadow-lg shadow-indigo-500/30 hover:shadow-xl transition-all transform hover:-translate-y-0.5"
        >
          Take Another Quiz ↻
        </button>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon }) {
  return (
    <div className="glass rounded-2xl p-5 shadow-lg">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold">{label}</p>
          <p className="text-2xl font-bold text-slate-800 mt-1">{value}</p>
        </div>
        <span className="text-3xl opacity-80">{icon}</span>
      </div>
    </div>
  );
}