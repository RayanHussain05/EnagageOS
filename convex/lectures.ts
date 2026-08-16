import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const logIngest = internalMutation({
  args: {
    lectureId: v.string(),
    fileKey: v.string(),
    courseId: v.optional(v.string()),
    sourceType: v.string(),
    chunksCreated: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("lectureAssets")
      .withIndex("by_lecture_file", (q) =>
        q.eq("lectureId", args.lectureId).eq("fileKey", args.fileKey)
      )
      .unique();

    const payload = {
      lectureId: args.lectureId,
      fileKey: args.fileKey,
      courseId: args.courseId,
      sourceType: args.sourceType,
      chunksCreated: args.chunksCreated,
      ingestedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }

    return ctx.db.insert("lectureAssets", payload);
  },
});

export const getCourseIdForLecture = internalQuery({
  args: {
    lectureId: v.string(),
  },
  handler: async (ctx, args) => {
    const asset = await ctx.db
      .query("lectureAssets")
      .withIndex("by_lecture", (q) => q.eq("lectureId", args.lectureId))
      .order("desc")
      .first();
    return asset?.courseId ?? null;
  },
});
