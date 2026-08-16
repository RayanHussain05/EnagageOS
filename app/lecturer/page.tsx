"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { SignInButton, UserButton, useUser } from "@clerk/nextjs";

const formatTime = (timestamp?: number) => {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleTimeString();
};

const formatConfidence = (value: number) => `${Math.round(value * 100)}%`;

const confidenceTone = (value: number) => {
  if (value >= 0.75) return "text-emerald-200 bg-emerald-400/10 border-emerald-400/40";
  if (value >= 0.55) return "text-cyan-200 bg-cyan-400/10 border-cyan-400/40";
  if (value >= 0.4) return "text-amber-200 bg-amber-400/10 border-amber-400/40";
  return "text-rose-200 bg-rose-400/10 border-rose-400/40";
};

const encodePcm16 = (samples: Float32Array) => {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < samples.length; i += 1) {
    let sample = samples[i];
    sample = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return buffer;
};

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export default function LecturerPage() {
  const { user } = useUser();
  const ensureUser = useMutation(api.users.upsertUser);
  const profile = useQuery(api.users.getMyProfile);
  const studentSignins = useQuery(api.users.getStudentSignins, { limit: 24 });
  const startSession = useMutation(api.sessions.startSession);
  const endSession = useMutation(api.sessions.endSession);
  const appendTranscriptSegment = useMutation(api.transcripts.appendSegment);
  const createLiveToken = useAction(api.transcribe.createLiveTranscribeToken);

  const [lectureId, setLectureId] = useState("cs101-week1");
  const [status, setStatus] = useState<string>("");
  const [copyStatus, setCopyStatus] = useState<string>("");

  const [isRecording, setIsRecording] = useState(false);
  const [transcriptSegments, setTranscriptSegments] = useState<string[]>([]);
  const [transcriptError, setTranscriptError] = useState<string>("");
  const [transcriptStatus, setTranscriptStatus] = useState<string>("Idle");
  const [transcriptCopied, setTranscriptCopied] = useState<string>("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsReadyRef = useRef(false);
  const lastTranscriptSentRef = useRef<string>("");

  useEffect(() => {
    if (user) {
      void ensureUser({});
    }
  }, [user, ensureUser]);

  const activeSession = useQuery(
    api.sessions.getActiveSession,
    lectureId ? { lectureId } : "skip"
  );


  const insights = useQuery(
    api.questions.getLectureInsights,
    lectureId ? { lectureId, limit: 240 } : "skip"
  );

  const startedAtLabel = useMemo(() => {
    if (!activeSession?.startedAt) return "—";
    return new Date(activeSession.startedAt).toLocaleTimeString();
  }, [activeSession?.startedAt]);

  const transcriptText = useMemo(() => transcriptSegments.join(" "), [transcriptSegments]);


  const appendTranscript = (text: string) => {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    setTranscriptSegments((prev) => {
      if (prev.length === 0) return [cleaned];
      const last = prev[prev.length - 1];
      if (cleaned === last) return prev;
      if (cleaned.startsWith(last)) {
        return [...prev.slice(0, -1), cleaned];
      }
      if (last.startsWith(cleaned)) return prev;
      return [...prev, cleaned];
    });

    if (!activeSession?._id) return;
    if (cleaned === lastTranscriptSentRef.current) return;
    lastTranscriptSentRef.current = cleaned;
    void appendTranscriptSegment({
      lectureId,
      sessionId: activeSession._id as any,
      text: cleaned,
    });
  };

  const closeLiveSocket = () => {
    wsReadyRef.current = false;
    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "stop" }));
        }
        wsRef.current.close();
      } catch {
        // ignore
      }
    }
    wsRef.current = null;
  };

  const connectLiveSocket = async () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && wsReadyRef.current) {
      return;
    }
    if (!activeSession?._id) {
      throw new Error("Start a session before recording.");
    }
    setTranscriptStatus("Connecting");
    const { token, wsUrl } = await createLiveToken({
      lectureId,
      sessionId: activeSession._id as any,
    });
    const normalized = wsUrl.replace(/\/$/, "");
    const wsEndpoint = `${normalized}/live?token=${encodeURIComponent(token)}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsEndpoint);
      wsRef.current = ws;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        fn();
      };
      const timeout = window.setTimeout(() => {
        ws.close();
        finish(() => reject(new Error("Live connection timed out")));
      }, 8000);

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "ready") {
            wsReadyRef.current = true;
            setTranscriptStatus("Listening");
            finish(resolve);
            return;
          }
          if (payload.type === "transcript" && payload.text) {
            appendTranscript(payload.text);
          } else if (payload.type === "error" && payload.message) {
            setTranscriptError(payload.message);
          }
        } catch {
          // ignore invalid JSON
        }
      };

      ws.onerror = () => {
        finish(() => reject(new Error("Live connection failed")));
      };

      ws.onclose = (event) => {
        wsReadyRef.current = false;
        if (!settled) {
          finish(() =>
            reject(
              new Error(
                `Live connection closed (${event.code}${
                  event.reason ? `: ${event.reason}` : ""
                })`
              )
            )
          );
        }
        if (isRecording) {
          setTranscriptStatus("Paused");
        }
      };
    });
  };

  const downsampleBuffer = (buffer: Float32Array, inputRate: number, targetRate: number) => {
    if (targetRate === inputRate) return buffer;
    const ratio = inputRate / targetRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offset = 0;
    for (let i = 0; i < newLength; i += 1) {
      const nextOffset = Math.round((i + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (; offset < nextOffset && offset < buffer.length; offset += 1) {
        sum += buffer[offset];
        count += 1;
      }
      result[i] = count ? sum / count : 0;
    }
    return result;
  };

  const onStart = async () => {
    setStatus("");
    try {
      const result = await startSession({ lectureId });
      setStatus(`Session started. Code: ${result.code}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const onCopyCode = async () => {
    if (!activeSession?.code) return;
    try {
      await navigator.clipboard.writeText(activeSession.code);
      setCopyStatus("Copied!");
    } catch {
      setCopyStatus("Copy failed");
    } finally {
      setTimeout(() => setCopyStatus(""), 1600);
    }
  };

  const onEnd = async () => {
    if (!activeSession?._id) return;
    setStatus("");
    try {
      await endSession({ sessionId: activeSession._id });
      setStatus("Session ended.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const stopRecording = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
    }
    mediaRecorderRef.current = null;
    streamRef.current = null;
    processorRef.current = null;
    sourceRef.current = null;
    audioContextRef.current = null;
    closeLiveSocket();
    setIsRecording(false);
    setTranscriptStatus("Paused");
  };

  const startRecording = async () => {
    setTranscriptError("");
    if (!activeSession?._id) {
      setTranscriptError("Start a session before recording.");
      return;
    }
    if (!navigator.mediaDevices) {
      setTranscriptError("Recording is not supported in this browser.");
      return;
    }
    try {
      await connectLiveSocket();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      const gain = audioContext.createGain();
      gain.gain.value = 0;

      processor.onaudioprocess = (event) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN || !wsReadyRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleBuffer(input, audioContext.sampleRate, 16000);
        const pcmBuffer = encodePcm16(downsampled);
        const base64 = arrayBufferToBase64(pcmBuffer);
        ws.send(
          JSON.stringify({
            type: "audio",
            data: base64,
            mimeType: "audio/pcm;rate=16000",
          })
        );
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(audioContext.destination);

      setIsRecording(true);
      setTranscriptStatus("Listening");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTranscriptError((prev) => (prev ? prev : message));
      closeLiveSocket();
      setTranscriptStatus("Paused");
    }
  };

  const onCopyTranscript = async () => {
    if (!transcriptText) return;
    try {
      await navigator.clipboard.writeText(transcriptText);
      setTranscriptCopied("Copied");
    } catch {
      setTranscriptCopied("Copy failed");
    } finally {
      setTimeout(() => setTranscriptCopied(""), 1600);
    }
  };

  const onClearTranscript = () => {
    setTranscriptSegments([]);
    setTranscriptCopied("");
  };

  useEffect(() => {
    return () => stopRecording();
  }, []);

  if (!user) {
    return (
      <main className="min-h-screen bg-[#05070d] text-slate-100 flex items-center justify-center">
        <SignInButton mode="modal">
          <button className="rounded-full bg-cyan-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400">
            Sign in
          </button>
        </SignInButton>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#05070d] text-slate-100">
      <div className="pointer-events-none absolute -top-48 right-[-12rem] h-[30rem] w-[30rem] rounded-full bg-cyan-500/20 blur-[160px]" />
      <div className="pointer-events-none absolute top-12 left-[-14rem] h-[32rem] w-[32rem] rounded-full bg-fuchsia-500/15 blur-[180px]" />
      <div className="pointer-events-none absolute bottom-[-16rem] right-[-8rem] h-[28rem] w-[28rem] rounded-full bg-emerald-400/20 blur-[160px]" />

      <div className="mx-auto max-w-7xl px-6 py-10">
        <header className="flex flex-wrap items-center justify-between gap-6">
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-[0.5em] text-cyan-200/80">Lecturer command deck</p>
            <h1 className="text-4xl font-semibold text-white md:text-5xl">
              Live signal control for your lecture.
            </h1>
            <p className="max-w-2xl text-base text-slate-400">
              Run sessions, broadcast the code, and see where students stall in real time. The Mini‑TA
              surfaces the pressure points so you can adapt instantly.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-full border border-slate-700/50 bg-slate-900/60 px-3 py-1 text-xs text-slate-300">
              {profile?.role === "lecturer" ? "Lecturer access" : "Role pending"}
            </div>
            <UserButton />
          </div>
        </header>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1.25fr_0.75fr]">
          <section className="space-y-6">
            <div className="rounded-[32px] border border-slate-800/70 bg-gradient-to-br from-slate-900/90 via-slate-900/50 to-slate-950/90 p-8 shadow-[0_0_70px_rgba(12,18,30,0.7)]">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.35em] text-slate-400">Session control</p>
                  <h2 className="mt-3 text-2xl font-semibold">Start, broadcast, and steer.</h2>
                  <p className="mt-2 text-slate-400">
                    Activate the room only when you’re live. Students can only join active codes.
                  </p>
                </div>
                <div className="rounded-full bg-slate-800/80 px-3 py-1 text-xs text-slate-300">
                  Active: {activeSession?.code ?? "—"}
                </div>
              </div>

              <div className="mt-6 grid gap-4 sm:grid-cols-[1fr_auto]">
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-[0.25em] text-slate-400">Lecture ID</label>
                  <input
                    className="w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 outline-none focus:border-cyan-400/60"
                    value={lectureId}
                    onChange={(e) => setLectureId(e.target.value)}
                  />
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <button
                    className="rounded-2xl bg-cyan-400 px-6 py-3 text-sm font-semibold text-slate-950 hover:bg-cyan-300"
                    onClick={onStart}
                  >
                    Start session
                  </button>
                  <button
                    className="rounded-2xl border border-slate-700/80 px-6 py-3 text-sm font-semibold text-slate-200 hover:border-slate-500 disabled:opacity-50"
                    onClick={onEnd}
                    disabled={!activeSession}
                  >
                    End session
                  </button>
                </div>
              </div>

              {status && (
                <div className="mt-4 rounded-2xl border border-slate-700/80 bg-slate-950/60 p-4 text-sm text-slate-300">
                  {status}
                </div>
              )}

              {profile?.role !== "lecturer" && (
                <div className="mt-4 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
                  <p>
                    You are not a lecturer yet. Ask an admin to add your Clerk ID to ADMIN_USER_IDS,
                    then run the role assignment.
                  </p>
                  <p className="mt-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs">
                    Your Clerk ID: {user.id}
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-3xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/10 via-slate-900/70 to-slate-950/90 p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.35em] text-emerald-200/80">Live transcription</p>
                  <h3 className="mt-2 text-xl font-semibold">Capture every word in real time.</h3>
                  <p className="mt-2 text-sm text-slate-400">
                    Hit record to stream the lecture into a live transcript. This will appear for your
                    own reference and can be reused in the recap.
                  </p>
                </div>
                <div className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200">
                  {transcriptStatus}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  className="rounded-2xl bg-emerald-400 px-5 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-300 disabled:opacity-60"
                  onClick={startRecording}
                  disabled={isRecording}
                >
                  Start recording
                </button>
                <button
                  className="rounded-2xl border border-slate-700/70 px-5 py-2 text-xs font-semibold text-slate-200 hover:border-slate-500 disabled:opacity-60"
                  onClick={stopRecording}
                  disabled={!isRecording}
                >
                  Stop
                </button>
                <button
                  className="rounded-2xl border border-slate-700/60 px-5 py-2 text-xs font-semibold text-slate-300 hover:border-slate-500"
                  onClick={onClearTranscript}
                >
                  Clear
                </button>
                <button
                  className="rounded-2xl border border-slate-700/60 px-5 py-2 text-xs font-semibold text-slate-300 hover:border-slate-500"
                  onClick={onCopyTranscript}
                  disabled={!transcriptText}
                >
                  Copy
                </button>
                {transcriptCopied && <span className="text-xs text-emerald-200">{transcriptCopied}</span>}
              </div>

              <div className="mt-4 flex items-center gap-4">
                <div className="flex items-end gap-1">
                  {[12, 20, 28, 18, 24].map((height, index) => (
                    <span
                      key={`bar-${index}`}
                      className={`w-1.5 rounded-full bg-emerald-400/80 ${
                        isRecording ? "animate-pulse" : "opacity-40"
                      }`}
                      style={{ height: `${height}px`, animationDelay: `${index * 120}ms` }}
                    />
                  ))}
                </div>
                <p className="text-xs text-slate-400">
                  {isRecording ? "Listening…" : "Idle"} • {transcriptSegments.length} segments
                </p>
              </div>

              {transcriptError && (
                <p className="mt-3 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
                  {transcriptError}
                </p>
              )}

              <div className="mt-4 max-h-52 overflow-y-auto rounded-2xl border border-slate-800/70 bg-slate-950/60 p-4 text-sm text-slate-200">
                {transcriptText || "Transcript will appear here once recording starts."}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-3xl border border-slate-800/70 bg-slate-900/60 p-5">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Total questions</p>
                <p className="mt-3 text-3xl font-semibold text-white">{insights?.total ?? "—"}</p>
              </div>
              <div className="rounded-3xl border border-slate-800/70 bg-slate-900/60 p-5">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">LLM misses</p>
                <p className="mt-3 text-3xl font-semibold text-rose-200">
                  {insights?.unansweredCount ?? "—"}
                </p>
              </div>
              <div className="rounded-3xl border border-slate-800/70 bg-slate-900/60 p-5">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Avg confidence</p>
                <p className="mt-3 text-3xl font-semibold text-cyan-200">
                  {insights ? formatConfidence(insights.avgConfidence) : "—"}
                </p>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-3xl border border-rose-500/30 bg-gradient-to-br from-rose-500/10 via-slate-900/60 to-slate-950/90 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.35em] text-rose-200/80">LLM couldn’t answer</p>
                    <h3 className="mt-2 text-xl font-semibold">Show these gaps live.</h3>
                  </div>
                  <div className="rounded-full border border-rose-400/30 bg-rose-400/10 px-3 py-1 text-xs text-rose-200">
                    {insights?.unansweredTop?.length ?? 0} topics
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  {insights?.unansweredTop?.length ? (
                    insights.unansweredTop.map((item) => (
                      <div
                        key={item.question}
                        className="rounded-2xl border border-rose-400/20 bg-slate-950/50 px-4 py-3"
                      >
                        <p className="text-sm text-slate-100">{item.question}</p>
                        <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                          <span>{item.count} asks</span>
                          <span>Last: {formatTime(item.lastAskedAt)}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-slate-400">No misses yet. Keep moving.</p>
                  )}
                </div>
              </div>

              <div className="rounded-3xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 via-slate-900/60 to-slate-950/90 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.35em] text-cyan-200/80">Most asked</p>
                    <h3 className="mt-2 text-xl font-semibold">Recurring pressure points.</h3>
                  </div>
                  <div className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-200">
                    {insights?.topAsked?.length ?? 0} topics
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  {insights?.topAsked?.length ? (
                    insights.topAsked.map((item) => (
                      <div
                        key={item.question}
                        className="rounded-2xl border border-cyan-400/20 bg-slate-950/50 px-4 py-3"
                      >
                        <p className="text-sm text-slate-100">{item.question}</p>
                        <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                          <span>{item.count} asks</span>
                          <span>Last: {formatTime(item.lastAskedAt)}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-slate-400">No repeated questions yet.</p>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800/70 bg-slate-900/60 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.35em] text-slate-400">Recent questions</p>
                  <h3 className="mt-2 text-xl font-semibold">Live feed</h3>
                </div>
                <div className="rounded-full border border-slate-700/60 bg-slate-950/60 px-3 py-1 text-xs text-slate-300">
                  {insights?.recent?.length ?? 0} latest
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {insights?.recent?.length ? (
                  insights.recent.map((item, index) => (
                    <div
                      key={`${item.question}-${index}`}
                      className="rounded-2xl border border-slate-800/70 bg-slate-950/60 px-4 py-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm text-slate-100">{item.question}</p>
                        <span
                          className={`rounded-full border px-3 py-1 text-xs ${confidenceTone(
                            item.confidence
                          )}`}
                        >
                          {formatConfidence(item.confidence)}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                        <span>{formatTime(item.createdAt)}</span>
                        {item.answer?.toLowerCase().startsWith("i don't know") && (
                          <span className="text-rose-200">LLM miss</span>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-400">No questions yet.</p>
                )}
              </div>
            </div>
          </section>

          <aside className="space-y-6">
            <div className="rounded-3xl border border-emerald-400/30 bg-gradient-to-br from-emerald-400/15 via-slate-900/70 to-slate-950/90 p-6">
              <h3 className="text-lg font-semibold">Live session code</h3>
              <p className="mt-1 text-sm text-slate-400">Share this entry code with students.</p>
              <div className="mt-4 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-4">
                <div className="text-xs uppercase tracking-[0.25em] text-emerald-200/80">Entry code</div>
                <div className="mt-2 font-mono text-3xl text-emerald-100">
                  {activeSession?.code ?? "— — — —"}
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <span>Lecture: {lectureId}</span>
                <span>Started: {startedAtLabel}</span>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <button
                  className="rounded-xl border border-slate-700/70 px-4 py-2 text-xs font-semibold text-slate-200 hover:border-slate-500"
                  onClick={onCopyCode}
                  disabled={!activeSession?.code}
                >
                  Copy code
                </button>
                {copyStatus && <span className="text-xs text-emerald-200">{copyStatus}</span>}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800/70 bg-slate-900/60 p-6">
              <h3 className="text-lg font-semibold">Engagement playbook</h3>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 px-4 py-3">
                  Pause every 10–15 minutes for a live recap.
                </div>
                <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 px-4 py-3">
                  Use the LLM miss list to re-explain key ideas.
                </div>
                <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 px-4 py-3">
                  If one question spikes, slow down and draw it out.
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 via-slate-900/70 to-slate-950/90 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.35em] text-cyan-200/80">Recent sign-ins</p>
                  <h3 className="mt-2 text-lg font-semibold">Who’s in the room</h3>
                </div>
                <div className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-200">
                  {studentSignins ? studentSignins.totalStudents : "—"}
                </div>
              </div>
              <div className="mt-4 space-y-3 text-sm text-slate-200">
                {!studentSignins && (
                  <p className="text-sm text-slate-400">Loading sign-ins…</p>
                )}
                {studentSignins && studentSignins.students.length === 0 && (
                  <p className="text-sm text-slate-400">No one has signed in yet.</p>
                )}
                {studentSignins &&
                  studentSignins.students.map((userItem) => (
                    <div
                      key={userItem.clerkId}
                      className="rounded-2xl border border-slate-800/70 bg-slate-950/60 px-4 py-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm text-slate-100">
                          {userItem.displayName ?? userItem.email ?? userItem.clerkId}
                        </div>
                        {userItem.email && (
                          <span className="rounded-full border border-slate-700/70 bg-slate-900/60 px-3 py-1 text-xs text-slate-300">
                            {userItem.email}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 text-xs text-slate-400">
                        Last active: {formatTime(userItem.updatedAt)}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
