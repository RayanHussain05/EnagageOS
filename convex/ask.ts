import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const requireEnv = (key: string) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
};

type AskResponse = {
  answer: string;
  confidence: number;
  citations: Array<{ source_id?: string; page?: number; chunk_id?: string }>;
  top_chunks: Array<{ chunk_id: string; score: number }>;
};

const stripQuestionPrefix = (answer: string, question: string) => {
  const cleaned = answer.trim();
  const q = question.trim().replace(/\?$/, "").toLowerCase();
  if (q && cleaned.toLowerCase().startsWith(q)) {
    const suffix = cleaned.slice(q.length).trim();
    return suffix.replace(/^[:\-–—]\s*/, "") || cleaned;
  }
  return cleaned;
};

const joinWithAnd = (items: string[]) => {
  const cleaned = items.map((item) => item.replace(/\.*$/, "").trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join(", ")}, and ${cleaned[cleaned.length - 1]}`;
};

const isTitleLike = (text: string) => {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  if (!/^[A-Za-z ]+$/.test(text)) return false;
  return words.every((word) => word[0] === word[0]?.toUpperCase());
};

const normalizeBulletAnswer = (answer: string, question: string) => {
  if (!answer) return answer;
  let cleaned = stripQuestionPrefix(answer, question).replace(/\s+/g, " ").trim();
  if (!/[•\*]/.test(cleaned)) return cleaned;

  let parts = cleaned
    .split(/[•\*]/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return cleaned;
  if (parts[0].endsWith("?")) {
    parts = parts.slice(1);
  }
  if (parts.length > 2 && isTitleLike(parts[0])) {
    parts = parts.slice(1);
  }
  if (parts.length === 0) return cleaned;

  if (parts[0].endsWith(":") && parts.length > 1) {
    const intro = parts[0].replace(/:$/, "").trim();
    const rest = joinWithAnd(parts.slice(1));
    return `${intro} ${rest}.`.replace(/\s+\./g, ".");
  }

  const sentences = parts.map((segment) => {
    let s = segment.replace(/\s+/g, " ").trim();
    if (!/[.!?]$/.test(s)) s += ".";
    return s[0]?.toUpperCase() + s.slice(1);
  });
  return sentences.join(" ").replace(/\s+\./g, ".");
};

export const askLecture = action({
  args: {
    lectureId: v.string(),
    sessionId: v.id("sessions"),
    question: v.string(),
    studentId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AskResponse> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const userId = args.studentId ?? identity.subject;

    const session = (await ctx.runQuery(internal.sessions.getSessionById, {
      sessionId: args.sessionId,
    })) as any;

    if (!session || !session.active || session.lectureId !== args.lectureId) {
      throw new Error("Lecture session is not active");
    }

    const attendance = await ctx.runQuery(internal.sessions.getAttendance, {
      sessionId: args.sessionId,
      userId,
    });

    if (!attendance) {
      throw new Error("Join the lecture before asking questions");
    }

    const courseId = await ctx.runQuery(internal.lectures.getCourseIdForLecture, {
      lectureId: args.lectureId,
    });

    const transcriptContext = await ctx.runQuery(internal.transcripts.getTranscriptContext, {
      lectureId: args.lectureId,
      sessionId: args.sessionId,
      minutes: 20,
      limit: 140,
    });

    const baseUrl = requireEnv("ENGAGEOS_RAG_URL");
    const token = requireEnv("ENGAGEOS_RAG_TOKEN");

    const res: Response = await fetch(`${baseUrl}/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        lecture_id: args.lectureId,
        course_id: courseId ?? undefined,
        question: args.question,
        student_id: userId,
        context_override: transcriptContext
          ? `Live transcript (most recent): ${transcriptContext}`
          : undefined,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`RAG ask failed (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as AskResponse;

    const citations = data.citations ?? [];
    const topChunks = data.top_chunks ?? [];
    const cleanedAnswer = normalizeBulletAnswer(data.answer ?? "", args.question);

    await ctx.runMutation(internal.questions.logQuestion, {
      lectureId: args.lectureId,
      sessionId: args.sessionId,
      studentId: userId,
      question: args.question,
      answer: cleanedAnswer,
      confidence: data.confidence ?? 0,
      citations,
      top_chunks: topChunks,
    });

    return {
      ...data,
      answer: cleanedAnswer,
    };
  },
});
