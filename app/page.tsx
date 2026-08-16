"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";

export default function HomeGate() {
  const router = useRouter();
  const { user, isLoaded } = useUser();

  useEffect(() => {
    if (!isLoaded) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    router.replace("/post-login");
  }, [isLoaded, user, router]);

  return (
    <main className="min-h-screen bg-[#05070d] text-slate-100 flex items-center justify-center">
      <div className="rounded-3xl border border-slate-800/70 bg-slate-900/60 p-8 text-center">
        <p className="text-sm text-slate-300">Preparing your session…</p>
      </div>
    </main>
  );
}
