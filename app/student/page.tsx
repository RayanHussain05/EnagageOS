"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAction, useMutation, useQuery, Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { api } from "../../convex/_generated/api";
import { SignInButton, UserButton, useUser } from "@clerk/nextjs";

const formatConfidence = (value: number) => `${Math.round(value * 100)}%`;

const normalizeForDisplay = (answer: string) =>
  answer.replace(/\s*•\s*/g, " ").replace(/\s+/g, " ").trim();

const highlightAnswer = (answer: string) => {
  const cleaned = normalizeForDisplay(answer);
  const parts = cleaned.match(/[^.!?]+[.!?]*/g);
  if (!parts) return [cleaned];
  return parts.map((part) => part.trim()).filter(Boolean);
};

type PromptPreset = {
  id: string;
  title: string;
  prompt: string;
  hint: string;
};

const promptPresets: PromptPreset[] = [
  {
    id: "overview",
    title: "Quick catch-up",
    prompt: "Give me a brief overview of the lecture so far in 3–5 sentences.",
    hint: "Short summary",
  },
  {
    id: "definitions",
    title: "Key terms",
    prompt: "What are the key terms from today and their short definitions?",
    hint: "Concept glossary",
  },
  {
    id: "steps",
    title: "Process steps",
    prompt: "Explain the main process step-by-step in clear sentences.",
    hint: "How it works",
  },
  {
    id: "example",
    title: "One example",
    prompt: "Give one concrete example that connects the main ideas.",
    hint: "Make it tangible",
  },
];

export default function Home() {
  const askLecture = useAction(api.ask.askLecture);
  const joinSession = useMutation(api.sessions.joinSession);
  const ensureUser = useMutation(api.users.upsertUser);
  const router = useRouter();
  const { user, isLoaded } = useUser();

  const [lectureCode, setLectureCode] = useState("");
  const [activeLectureId, setActiveLectureId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const [askResult, setAskResult] = useState<{
    answer: string;
    confidence: number;
    citations: Array<{ source_id?: string; page?: number; chunk_id?: string }>;
    top_chunks: Array<{ chunk_id: string; score: number }>;
  } | null>(null);
  const [askError, setAskError] = useState<string>("");
  const [joinError, setJoinError] = useState<string>("");
  const [loadingAsk, setLoadingAsk] = useState(false);
  const [loadingJoin, setLoadingJoin] = useState(false);
  const [lastAskedAt, setLastAskedAt] = useState<string>("");
  const [questionsAsked, setQuestionsAsked] = useState(0);

  const transcriptSegments = useQuery(
    api.transcripts.getRecentSegments,
    activeLectureId && activeSessionId
      ? { lectureId: activeLectureId, sessionId: activeSessionId as any, limit: 80 }
      : "skip"
  );

  const transcriptText = useMemo(() => {
    if (!transcriptSegments?.length) return "";
    return transcriptSegments.map((segment) => segment.text).join(" ");
  }, [transcriptSegments]);

  useEffect(() => {
    if (user) {
      void ensureUser({});
    }
  }, [user, ensureUser]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!user) {
      router.replace("/login");
    }
  }, [isLoaded, user, router]);

  const onJoin = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = lectureCode.trim().toUpperCase();
    if (!trimmed) return;
    setLoadingJoin(true);
    setJoinError("");
    try {
      const result = await joinSession({ code: trimmed });
      setActiveLectureId(result.lectureId);
      setActiveSessionId(result.sessionId as string);
      setAskResult(null);
      setAskError("");
      setFocusLabel(null);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingJoin(false);
    }
  };

  const onAsk = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeLectureId || !activeSessionId || !question.trim()) return;
    setLoadingAsk(true);
    setAskResult(null);
    setAskError("");
    try {
      const result = await askLecture({
        lectureId: activeLectureId,
        sessionId: activeSessionId as any,
        question: question.trim(),
        studentId: user?.id,
      });
      setAskResult(result);
      setLastAskedAt(new Date().toLocaleTimeString());
      setQuestionsAsked((prev) => prev + 1);
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingAsk(false);
    }
  };

  const onSelectPreset = (preset: PromptPreset) => {
    setQuestion(preset.prompt);
    setFocusLabel(preset.title);
  };

  const statusLabel = useMemo(() => {
    if (!activeLectureId) return "Not connected";
    return `Connected to ${activeLectureId}`;
  }, [activeLectureId]);

  const questionCount = question.trim().length;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#05070d] text-slate-100">
      <div className="pointer-events-none absolute -top-40 right-[-8rem] h-[26rem] w-[26rem] rounded-full bg-cyan-500/20 blur-[140px]" />
      <div className="pointer-events-none absolute top-16 left-[-12rem] h-[30rem] w-[30rem] rounded-full bg-emerald-500/10 blur-[160px]" />
      <div className="pointer-events-none absolute bottom-[-14rem] right-[-10rem] h-[28rem] w-[28rem] rounded-full bg-fuchsia-500/10 blur-[170px]" />

      <div className="mx-auto max-w-7xl px-6 py-10">
        <header className="flex flex-wrap items-center justify-between gap-6">
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-[0.45em] text-cyan-200/80">Student studio</p>
            <h1 className="text-4xl font-semibold text-white md:text-5xl">
              Mini‑TA, tuned for real‑time learning.
            </h1>
            <p className="max-w-2xl text-base text-slate-400">
              Join the lecture, grab a clean catch‑up, and ask for clarity without raising your hand.
              We surface what you need to move forward.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Authenticated>
              <div className="rounded-full border border-slate-800/70 bg-slate-900/70 px-3 py-1 text-xs text-slate-300">
                {statusLabel}
              </div>
              <UserButton />
            </Authenticated>
            <Unauthenticated>
              <SignInButton mode="modal">
                <button className="rounded-full bg-cyan-400 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300">
                  Sign in
                </button>
              </SignInButton>
            </Unauthenticated>
          </div>
        </header>

        <AuthLoading>
          <div className="mt-10 rounded-2xl border border-slate-800/70 bg-slate-900/50 p-6 text-slate-300">
            Loading authentication...
          </div>
        </AuthLoading>

        <Unauthenticated>
          <div className="mt-10 rounded-3xl border border-slate-800/70 bg-slate-900/60 p-8">
            <h2 className="text-xl font-semibold">Sign in to join your lecture</h2>
            <p className="mt-2 text-slate-400">
              EngageOS keeps your questions private while giving lecturers real-time insight.
            </p>
            <div className="mt-4">
              <a
                href="/login"
                className="inline-flex items-center rounded-full bg-cyan-400 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300"
              >
                Go to login
              </a>
            </div>
          </div>
        </Unauthenticated>

        <Authenticated>
          <div className="mt-10 grid gap-8 lg:grid-cols-[2.2fr_1fr]">
            <div className="space-y-6">
              <section className="rounded-3xl border border-slate-800/70 bg-gradient-to-br from-slate-900/80 via-slate-900/40 to-slate-950/80 p-8 shadow-[0_0_60px_rgba(12,18,30,0.7)]">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-semibold">Join the live lecture</h2>
                    <p className="text-slate-400">Enter the code and unlock the live knowledge stream.</p>
                  </div>
                  <div className="rounded-full bg-slate-800/80 px-3 py-1 text-xs text-slate-300">
                    Active: {activeLectureId ?? "—"}
                  </div>
                </div>

                <form onSubmit={onJoin} className="mt-6 grid gap-4 md:grid-cols-[1fr_auto]">
                  <input
                    className="w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 outline-none shadow-[0_0_0_1px_rgba(15,23,42,0.6)] focus:border-cyan-400/60"
                    placeholder="Enter lecture code"
                    value={lectureCode}
                    onChange={(e) => setLectureCode(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="rounded-2xl bg-cyan-400 px-6 py-3 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:opacity-50"
                    disabled={loadingJoin}
                  >
                    {loadingJoin ? "Joining..." : "Join"}
                  </button>
                </form>

                {joinError && (
                  <p className="mt-3 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                    {joinError}
                  </p>
                )}
              </section>

              <section className="rounded-3xl border border-slate-800/70 bg-slate-900/60 p-8 shadow-[0_0_50px_rgba(8,10,20,0.6)]">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.35em] text-emerald-200/80">Ask the mini‑TA</p>
                    <h3 className="mt-2 text-2xl font-semibold">Focus, then ask.</h3>
                    <p className="mt-2 max-w-xl text-slate-400">
                      Choose a learning goal or type your own question. We prioritize clarity and speed.
                    </p>
                  </div>
                  <div className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200">
                    {activeLectureId ? "Connected" : "Join a lecture first"}
                  </div>
                </div>

                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  {promptPresets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => onSelectPreset(preset)}
                      className="flex items-center justify-between rounded-2xl border border-slate-800/70 bg-slate-950/50 px-4 py-3 text-left text-sm text-slate-200 transition hover:border-emerald-400/50 hover:bg-slate-950/80"
                      disabled={!activeLectureId}
                    >
                      <span className="font-semibold">{preset.title}</span>
                      <span className="text-xs text-slate-400">{preset.hint}</span>
                    </button>
                  ))}
                </div>

                <form onSubmit={onAsk} className="mt-5 grid gap-4">
                  <textarea
                    className="min-h-[130px] w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 outline-none shadow-[0_0_0_1px_rgba(15,23,42,0.6)] focus:border-emerald-400/60"
                    placeholder="Type your question..."
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    disabled={!activeLectureId}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-3 text-xs text-slate-400">
                      <span>{questionCount}/500</span>
                      {focusLabel && (
                        <span className="rounded-full border border-slate-700/60 bg-slate-900/70 px-3 py-1 text-xs text-slate-300">
                          Focus: {focusLabel}
                        </span>
                      )}
                    </div>
                    <button
                      type="submit"
                      className="rounded-2xl bg-emerald-400 px-6 py-3 text-sm font-semibold text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={loadingAsk || !activeLectureId}
                    >
                      {loadingAsk ? "Asking..." : "Ask"}
                    </button>
                  </div>
                </form>
              </section>

              <details className="rounded-3xl border border-slate-800/70 bg-gradient-to-br from-slate-900/80 via-slate-900/50 to-slate-950/70 p-6">
                <summary className="cursor-pointer text-sm uppercase tracking-[0.35em] text-slate-300">
                  Live transcript
                </summary>
                <div className="mt-4 space-y-3 text-sm text-slate-200">
                  {!activeLectureId && (
                    <p className="text-slate-400">Join a lecture to view the live transcript.</p>
                  )}
                  {activeLectureId && transcriptSegments === undefined && (
                    <p className="text-slate-400">Loading transcript…</p>
                  )}
                  {activeLectureId && transcriptSegments?.length === 0 && (
                    <p className="text-slate-400">No transcript yet. It will appear once the lecturer starts recording.</p>
                  )}
                  {activeLectureId && transcriptSegments && transcriptSegments.length > 0 && (
                    <div className="max-h-56 space-y-2 overflow-y-auto rounded-2xl border border-slate-800/70 bg-slate-950/60 p-4">
                      {transcriptSegments.map((segment, index) => (
                        <div key={`${segment.createdAt}-${index}`} className="space-y-1">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                            {new Date(segment.createdAt).toLocaleTimeString()}
                          </div>
                          <p className="text-sm text-slate-100">{segment.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {activeLectureId && transcriptText && (
                    <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 p-3 text-xs text-slate-400">
                      Auto-updates while the lecturer is recording.
                    </div>
                  )}
                </div>
              </details>

              {(askResult || askError) && (
                <section className="rounded-3xl border border-slate-800/80 bg-slate-950/70 p-7 shadow-[inset_0_0_30px_rgba(15,23,42,0.6)]">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Answer</p>
                      <h4 className="mt-2 text-xl font-semibold">Here’s the clean version.</h4>
                    </div>
                    {askResult && (
                      <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200">
                        {formatConfidence(askResult.confidence)} confidence
                      </span>
                    )}
                  </div>

                  {askError && (
                    <p className="mt-4 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                      {askError}
                    </p>
                  )}

                  {askResult && (
                    <div className="mt-5 space-y-5">
                      <div className="space-y-3 text-base text-slate-100">
                        {highlightAnswer(askResult.answer).map((line, index) => (
                          <p key={index} className="leading-relaxed">
                            {line}
                          </p>
                        ))}
                      </div>

                      <details className="rounded-2xl border border-slate-800/70 bg-slate-900/60 p-4">
                        <summary className="cursor-pointer text-xs uppercase tracking-[0.25em] text-slate-400">
                          Sources & confidence
                        </summary>
                        <div className="mt-4 space-y-4">
                          <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 p-3">
                            <div className="flex items-center justify-between text-xs text-slate-400">
                              <span>Confidence meter</span>
                              <span>{formatConfidence(askResult.confidence)}</span>
                            </div>
                            <div className="mt-2 h-2 rounded-full bg-slate-800">
                              <div
                                className="h-2 rounded-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-blue-500"
                                style={{ width: `${Math.min(Math.max(askResult.confidence, 0), 1) * 100}%` }}
                              />
                            </div>
                          </div>

                          <div className="space-y-2">
                            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Sources</p>
                            {askResult.citations.length === 0 && (
                              <p className="text-sm text-slate-400">No citations returned.</p>
                            )}
                            <div className="flex flex-wrap gap-2">
                              {askResult.citations.slice(0, 4).map((cite, index) => (
                                <div
                                  key={`${cite.chunk_id ?? "chunk"}-${index}`}
                                  className="rounded-full border border-slate-700/70 bg-slate-900/60 px-3 py-1 text-xs text-slate-300"
                                >
                                  {cite.source_id ?? "source"} • p.{cite.page ?? "?"}
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-2">
                            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Top matches</p>
                            <div className="grid gap-2">
                              {askResult.top_chunks.slice(0, 3).map((chunk) => (
                                <div
                                  key={chunk.chunk_id}
                                  className="flex items-center justify-between rounded-2xl border border-slate-800/70 bg-slate-950/60 px-4 py-2 text-xs text-slate-300"
                                >
                                  <span>{chunk.chunk_id}</span>
                                  <span className="text-cyan-200">{formatConfidence(chunk.score)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </details>
                    </div>
                  )}
                </section>
              )}
            </div>

            <aside className="space-y-6">
              <div className="rounded-3xl border border-slate-800/70 bg-slate-900/60 p-6">
                <h3 className="text-lg font-semibold">Session status</h3>
                <dl className="mt-4 space-y-3 text-sm text-slate-300">
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-400">Lecture</dt>
                    <dd>{activeLectureId ?? "Not joined"}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-400">Questions asked</dt>
                    <dd>{questionsAsked}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-400">Last asked</dt>
                    <dd>{lastAskedAt || "—"}</dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-3xl border border-slate-800/70 bg-gradient-to-br from-slate-900/90 via-slate-900/60 to-slate-900/10 p-6">
                <h3 className="text-lg font-semibold">Learning flow</h3>
                <div className="mt-4 space-y-4 text-sm text-slate-300">
                  <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-cyan-200/70">Step 1</p>
                    <p className="mt-2">Join with the lecture code and stay synced with the room.</p>
                  </div>
                  <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-emerald-200/70">Step 2</p>
                    <p className="mt-2">Pick a focus or ask your question in your own words.</p>
                  </div>
                  <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-fuchsia-200/70">Step 3</p>
                    <p className="mt-2">Use the summary to catch up, then drill deeper.</p>
                  </div>
                </div>
              </div>

              <div className="rounded-3xl border border-slate-800/70 bg-slate-900/60 p-6">
                <h3 className="text-lg font-semibold">Engagement tips</h3>
                <ul className="mt-4 space-y-3 text-sm text-slate-300">
                  <li>Ask for definitions when new terms appear.</li>
                  <li>Summarize the concept in one sentence, then check with the Mini‑TA.</li>
                  <li>Spot-check with a follow-up question every 10–15 minutes.</li>
                </ul>
              </div>

              <div className="rounded-3xl border border-slate-800/70 bg-slate-900/60 p-6">
                <h3 className="text-lg font-semibold">Privacy note</h3>
                <p className="mt-3 text-sm text-slate-400">
                  Your identity is not shown to the lecturer. Only trends and topic counts are shared.
                </p>
              </div>
            </aside>
          </div>
        </Authenticated>
      </div>
    </main>
  );
}
