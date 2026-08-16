"use node";

import crypto from "crypto";
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

const toBase64Url = (input: string | Buffer) =>
  Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const signToken = (payload: Record<string, unknown>, secret: string) => {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = toBase64Url(payloadJson);
  const signature = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  const sigB64 = toBase64Url(signature);
  return `${payloadB64}.${sigB64}`;
};

const toWsBaseUrl = (baseUrl: string) =>
  baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");

export const transcribeLecture = action({
  args: {
    lectureId: v.string(),
    sessionId: v.id("sessions"),
    audioBase64: v.string(),
    mimeType: v.optional(v.string()),
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
      throw new Error("Only lecturers can transcribe audio");
    }

    const session = (await ctx.runQuery(internal.sessions.getSessionById, {
      sessionId: args.sessionId,
    })) as any;

    if (!session || !session.active || session.lectureId !== args.lectureId) {
      throw new Error("Lecture session is not active");
    }

    const baseUrl = requireEnv("ENGAGEOS_RAG_URL");
    const token = requireEnv("ENGAGEOS_RAG_TOKEN");

    const res = await fetch(`${baseUrl}/transcribe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        lecture_id: args.lectureId,
        session_id: args.sessionId,
        audio_base64: args.audioBase64,
        mime_type: args.mimeType ?? "audio/webm",
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`RAG transcribe failed (${res.status}): ${detail}`);
    }

    return res.json();
  },
});

export const createLiveTranscribeToken = action({
  args: {
    lectureId: v.string(),
    sessionId: v.id("sessions"),
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
      throw new Error("Only lecturers can open a live transcript");
    }

    const session = (await ctx.runQuery(internal.sessions.getSessionById, {
      sessionId: args.sessionId,
    })) as any;

    if (!session || !session.active || session.lectureId !== args.lectureId) {
      throw new Error("Lecture session is not active");
    }

    const baseUrl = requireEnv("ENGAGEOS_RAG_URL");
    const wsUrl = toWsBaseUrl(baseUrl);
    const secret = requireEnv("TRANSCRIBE_WS_SECRET");

    const now = Math.floor(Date.now() / 1000);
    const token = signToken(
      {
        sub: identity.subject,
        lectureId: args.lectureId,
        sessionId: args.sessionId,
        exp: now + 90,
      },
      secret
    );

    return {
      token,
      wsUrl,
    };
  },
});
