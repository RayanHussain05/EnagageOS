import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

const generateCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
};

const getRole = async (ctx: any, clerkId: string) => {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk", (q: any) => q.eq("clerkId", clerkId))
    .unique();
  return user?.role ?? "student";
};

export const startSession = mutation({
  args: {
    lectureId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const role = await getRole(ctx, identity.subject);
    if (role !== "lecturer") {
      throw new Error("Only lecturers can start sessions");
    }

    const activeSessions = await ctx.db
      .query("sessions")
      .withIndex("by_lecture_active", (q) => q.eq("lectureId", args.lectureId).eq("active", true))
      .collect();

    const now = Date.now();
    for (const session of activeSessions) {
      await ctx.db.patch(session._id, { active: false, endedAt: now });
    }

    let code = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateCode();
      const existing = await ctx.db
        .query("sessions")
        .withIndex("by_code", (q) => q.eq("code", candidate))
        .unique();
      if (!existing) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      throw new Error("Unable to generate unique session code");
    }

    const sessionId = await ctx.db.insert("sessions", {
      lectureId: args.lectureId,
      code,
      active: true,
      startedAt: now,
      createdBy: identity.subject,
    });

    return {
      sessionId,
      lectureId: args.lectureId,
      code,
      startedAt: now,
    };
  },
});

export const endSession = mutation({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const role = await getRole(ctx, identity.subject);
    if (role !== "lecturer") {
      throw new Error("Only lecturers can end sessions");
    }

    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    await ctx.db.patch(session._id, { active: false, endedAt: Date.now() });

    return { sessionId: session._id, active: false };
  },
});

export const joinSession = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("sessions")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();

    if (!session || !session.active) {
      throw new Error("Lecture code is not active");
    }

    const existing = await ctx.db
      .query("attendance")
      .withIndex("by_session_user", (q) =>
        q.eq("sessionId", session._id).eq("userId", identity.subject)
      )
      .unique();

    if (!existing) {
      await ctx.db.insert("attendance", {
        sessionId: session._id,
        userId: identity.subject,
        joinedAt: Date.now(),
      });
    }

    return {
      sessionId: session._id,
      lectureId: session.lectureId,
      code: session.code,
      startedAt: session.startedAt,
    };
  },
});

export const getActiveSession = query({
  args: {
    lectureId: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("sessions")
      .withIndex("by_lecture_active", (q) => q.eq("lectureId", args.lectureId).eq("active", true))
      .unique();
  },
});

export const getSessionById = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    return ctx.db.get(args.sessionId);
  },
});

export const getAttendance = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("attendance")
      .withIndex("by_session_user", (q) => q.eq("sessionId", args.sessionId).eq("userId", args.userId))
      .unique();
  },
});
