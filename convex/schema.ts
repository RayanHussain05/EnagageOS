import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const role = v.union(v.literal("student"), v.literal("lecturer"));

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    role,
    email: v.optional(v.string()),
    displayName: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerk", ["clerkId"])
    .index("by_updated", ["updatedAt"])
    .index("by_role", ["role"])
    .index("by_role_updated", ["role", "updatedAt"]),

  lectureAssets: defineTable({
    lectureId: v.string(),
    fileKey: v.string(),
    courseId: v.optional(v.string()),
    sourceType: v.string(),
    chunksCreated: v.number(),
    ingestedAt: v.number(),
  })
    .index("by_lecture", ["lectureId"])
    .index("by_lecture_file", ["lectureId", "fileKey"]),

  sessions: defineTable({
    lectureId: v.string(),
    code: v.string(),
    active: v.boolean(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    createdBy: v.string(),
  })
    .index("by_code", ["code"])
    .index("by_lecture_active", ["lectureId", "active"]),

  attendance: defineTable({
    sessionId: v.id("sessions"),
    userId: v.string(),
    joinedAt: v.number(),
  })
    .index("by_session_user", ["sessionId", "userId"])
    .index("by_user", ["userId"]),

  questions: defineTable({
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
    createdAt: v.number(),
  }).index("by_lecture", ["lectureId"]),

  transcripts: defineTable({
    lectureId: v.string(),
    sessionId: v.id("sessions"),
    text: v.string(),
    createdAt: v.number(),
  })
    .index("by_lecture", ["lectureId", "createdAt"])
    .index("by_session", ["sessionId", "createdAt"]),
});
