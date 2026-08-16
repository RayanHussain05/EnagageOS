import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

const parseAllowList = (value?: string) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const buildDisplayName = (identity: Record<string, unknown>) => {
  const name = typeof identity.name === "string" ? identity.name.trim() : "";
  if (name) return name;
  const given = typeof identity.givenName === "string" ? identity.givenName.trim() : "";
  const family = typeof identity.familyName === "string" ? identity.familyName.trim() : "";
  const combined = `${given} ${family}`.trim();
  if (combined) return combined;
  const nickname = typeof identity.nickname === "string" ? identity.nickname.trim() : "";
  if (nickname) return nickname;
  return undefined;
};

export const upsertUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject))
      .unique();

    const now = Date.now();
    const email = (identity as { email?: string }).email;
    const displayName = buildDisplayName(identity as Record<string, unknown>);
    if (existing) {
      const updates: Record<string, unknown> = { updatedAt: now };
      if (email && email !== existing.email) {
        updates.email = email;
      }
      if (displayName && displayName !== existing.displayName) {
        updates.displayName = displayName;
      }
      await ctx.db.patch(existing._id, updates);
      return existing._id;
    }

    return ctx.db.insert("users", {
      clerkId: identity.subject,
      role: "student",
      email: email ?? undefined,
      displayName: displayName ?? undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getMyProfile = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    return ctx.db
      .query("users")
      .withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject))
      .unique();
  },
});

export const setRole = mutation({
  args: {
    clerkId: v.string(),
    role: v.union(v.literal("student"), v.literal("lecturer")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const allowList = parseAllowList(process.env.ADMIN_USER_IDS);
    if (!allowList.includes(identity.subject)) {
      throw new Error("Only admins can assign roles");
    }

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    if (!existing) {
      throw new Error("User not found");
    }

    await ctx.db.patch(existing._id, {
      role: args.role,
      updatedAt: Date.now(),
    });

    return { clerkId: args.clerkId, role: args.role };
  },
});

export const getRoleByClerkId = internalQuery({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    return user?.role ?? "student";
  },
});

export const getRecentUsers = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const me = await ctx.db
      .query("users")
      .withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!me || me.role !== "lecturer") {
      throw new Error("Only lecturers can view sign-ins");
    }

    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const rows = await ctx.db
      .query("users")
      .withIndex("by_updated")
      .order("desc")
      .take(limit);

    return rows.map((row) => ({
      clerkId: row.clerkId,
      email: row.email ?? null,
      displayName: row.displayName ?? null,
      role: row.role,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },
});

export const getStudentSignins = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const me = await ctx.db
      .query("users")
      .withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!me || me.role !== "lecturer") {
      throw new Error("Only lecturers can view sign-ins");
    }

    const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
    const students = await ctx.db
      .query("users")
      .withIndex("by_role_updated", (q) => q.eq("role", "student"))
      .order("desc")
      .take(limit);

    const totalStudents = (
      await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "student")).collect()
    ).length;

    return {
      totalStudents,
      students: students.map((row) => ({
        clerkId: row.clerkId,
        email: row.email ?? null,
        displayName: row.displayName ?? null,
        updatedAt: row.updatedAt,
      })),
    };
  },
});
