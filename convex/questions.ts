import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

export const logQuestion = internalMutation({
  args: {
    lectureId: v.string(),
    sessionId: v.optional(v.id("sessions")),
    studentId: v.optional(v.string()),
    question: v.string(),
    answer: v.string(),
    confidence: v.number(),
    citations: v.array(
      v.object({
        source_id: v.optional(v.string()),
        page: v.optional(v.number()),
        chunk_id: v.optional(v.string()),
      })
    ),
    top_chunks: v.array(
      v.object({
        chunk_id: v.string(),
        score: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("questions", {
      lectureId: args.lectureId,
      sessionId: args.sessionId,
      studentId: args.studentId,
      question: args.question,
      answer: args.answer,
      confidence: args.confidence,
      citations: args.citations,
      top_chunks: args.top_chunks,
      createdAt: Date.now(),
    });
  },
});

const UNKNOWN_PREFIX = "I don't know based on the lecture materials.";

const normalizeQuestion = (question: string) =>
  question
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.]+$/g, "");

const buildTopList = (
  items: Array<{ question: string; createdAt: number }>
) => {
  const map = new Map<string, { question: string; count: number; lastAskedAt: number }>();
  for (const item of items) {
    const key = normalizeQuestion(item.question);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { question: item.question, count: 1, lastAskedAt: item.createdAt });
      continue;
    }
    existing.count += 1;
    if (item.createdAt > existing.lastAskedAt) {
      existing.lastAskedAt = item.createdAt;
      existing.question = item.question;
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastAskedAt - a.lastAskedAt;
  });
};

export const getLectureInsights = query({
  args: {
    lectureId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    const questions = await ctx.db
      .query("questions")
      .withIndex("by_lecture", (q) => q.eq("lectureId", args.lectureId))
      .order("desc")
      .take(limit);

    const total = questions.length;
    const avgConfidence =
      total === 0 ? 0 : questions.reduce((sum, q) => sum + q.confidence, 0) / total;

    const unanswered = questions.filter((q) =>
      q.answer?.trim().toLowerCase().startsWith(UNKNOWN_PREFIX.toLowerCase())
    );

    const unansweredTop = buildTopList(unanswered).slice(0, 6);
    const topAsked = buildTopList(questions).slice(0, 6);

    const recent = questions.slice(0, 8).map((q) => ({
      question: q.question,
      confidence: q.confidence,
      createdAt: q.createdAt,
      answer: q.answer,
    }));

    return {
      total,
      avgConfidence,
      unansweredCount: unanswered.length,
      unansweredTop,
      topAsked,
      recent,
    };
  },
});
