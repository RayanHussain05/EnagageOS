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

export const ingestLecture = action({
  args: {
    lectureId: v.string(),
    fileKey: v.string(),
    courseId: v.optional(v.string()),
    sourceType: v.optional(v.string()),
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
      throw new Error("Only lecturers can ingest lectures");
    }

    const baseUrl = requireEnv("ENGAGEOS_RAG_URL");
    const token = requireEnv("ENGAGEOS_RAG_TOKEN");

    const res = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        lecture_id: args.lectureId,
        file_key: args.fileKey,
        course_id: args.courseId,
        source_type: args.sourceType ?? "pdf",
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`RAG ingest failed (${res.status}): ${detail}`);
    }

    const data = await res.json();

    await ctx.runMutation(internal.lectures.logIngest, {
      lectureId: args.lectureId,
      fileKey: args.fileKey,
      courseId: args.courseId,
      sourceType: args.sourceType ?? "pdf",
      chunksCreated: data.chunks_created ?? data.chunksCreated ?? 0,
    });

    return data;
  },
});
