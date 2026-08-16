"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { SignIn, useUser } from "@clerk/nextjs";

export default function LoginPage() {
  const router = useRouter();
  const { user, isLoaded } = useUser();

  useEffect(() => {
    if (!isLoaded) return;
    if (user) {
      router.replace("/post-login");
    }
  }, [isLoaded, user, router]);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#05070d] text-slate-100">
      <div className="pointer-events-none absolute -top-40 right-[-10rem] h-[26rem] w-[26rem] rounded-full bg-cyan-500/20 blur-[140px]" />
      <div className="pointer-events-none absolute bottom-[-12rem] left-[-8rem] h-[28rem] w-[28rem] rounded-full bg-amber-400/15 blur-[160px]" />

      <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6 py-12">
        <div className="grid w-full gap-10 rounded-3xl border border-slate-800/70 bg-slate-900/60 p-10 lg:grid-cols-[1fr_auto]">
          <div className="space-y-4">
            <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/80">EngageOS</p>
            <h1 className="text-3xl font-semibold">Welcome back</h1>
            <p className="text-slate-400">
              Sign in to join your lecture or manage your live session. Students stay anonymous to
              peers, lecturers get signals in real time.
            </p>
            <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 p-4 text-sm text-slate-300">
              <p className="font-medium text-slate-200">What happens after you sign in?</p>
              <ul className="mt-2 space-y-2">
                <li>Students land in the lecture join view.</li>
                <li>Lecturers go straight to the control room.</li>
              </ul>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800/70 bg-slate-950/80 p-4">
            <SignIn routing="path" path="/login" />
          </div>
        </div>
      </div>
    </main>
  );
}
