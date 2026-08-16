"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useUser } from "@clerk/nextjs";

export default function PostLoginPage() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const ensureUser = useMutation(api.users.upsertUser);
  const profile = useQuery(api.users.getMyProfile);

  useEffect(() => {
    if (user) {
      void ensureUser({});
    }
  }, [user, ensureUser]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!user) {
      router.replace("/login");
    }
  }, [isLoaded, user, router]);

  useEffect(() => {
    if (!profile) return;
    if (profile.role === "lecturer") {
      router.replace("/lecturer");
    } else {
      router.replace("/student");
    }
  }, [profile, router]);

  return (
    <main className="min-h-screen bg-[#05070d] text-slate-100 flex items-center justify-center">
      <div className="rounded-3xl border border-slate-800/70 bg-slate-900/60 p-8 text-center">
        <p className="text-sm text-slate-300">Setting up your session…</p>
      </div>
    </main>
  );
}
