import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const appendSegment = mutation({
  args: {
    lectureId: v.string(),
    sessionId: v.id("sessions"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const role = await ctx.runQuery(internal.users.getRoleByClerkId, {
      clerkId: identity.subject,
    });
    if (role !== "lecturer") {
      throw new Error("Only lecturers can append transcripts");
    }

    const session = (await ctx.runQuery(internal.sessions.getSessionById, {
      sessionId: args.sessionId,
    })) as any;
    if (!session || !session.active || session.lectureId !== args.lectureId) {
      throw new Error("Lecture session is not active");
    }

    return ctx.db.insert("transcripts", {
      lectureId: args.lectureId,
      sessionId: args.sessionId,
      text: args.text.trim(),
      createdAt: Date.now(),
    });
  },
});

export const getRecentSegments = query({
  args: {
    lectureId: v.string(),
    sessionId: v.id("sessions"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query("transcripts")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(limit);

    return rows
      .map((row) => ({
        text: row.text,
        createdAt: row.createdAt,
      }))
      .reverse();
  },
});

export const getTranscriptContext = internalQuery({
  args: {
    lectureId: v.string(),
    sessionId: v.id("sessions"),
    minutes: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 120, 20), 300);
    const minutes = Math.min(Math.max(args.minutes ?? 20, 1), 120);
    const cutoff = Date.now() - minutes * 60 * 1000;

    const rows = await ctx.db
      .query("transcripts")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(limit);

    const filtered = rows.filter((row) => row.createdAt >= cutoff);
    if (filtered.length === 0) return null;

    return filtered
      .reverse()
      .map((row) => row.text)
      .join(" ");
  },
});
