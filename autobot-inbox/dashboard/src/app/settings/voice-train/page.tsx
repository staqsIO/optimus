"use client";

import { Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useState } from "react";

type Stage = "initial" | "training" | "done" | "error";

interface BootstrapResult {
  imported: number;
  profile: boolean;
  embeddingsGenerated: number;
}

function VoiceTrainContent() {
  const params = useSearchParams();
  const router = useRouter();
  const accountId = params.get("accountId") || "";
  const email = params.get("email") || "";
  const label = params.get("label") || "Gmail";

  const [stage, setStage] = useState<Stage>("initial");
  const [result, setResult] = useState<BootstrapResult | null>(null);
  const [error, setError] = useState("");

  const train = async () => {
    setStage("training");
    setError("");
    try {
      const res = await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/voice/bootstrap", body: { accountId } }),
      });
      if (!res.ok) throw new Error(`API /api/voice/bootstrap: ${res.status}`);
      const data = await res.json() as BootstrapResult;
      setResult(data);
      setStage("done");
    } catch (err) {
      setError((err as Error).message);
      setStage("error");
    }
  };

  const skip = async () => {
    try {
      const res = await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/accounts/activate", body: { accountId } }),
      });
      if (!res.ok) throw new Error(`API /api/accounts/activate: ${res.status}`);
      router.push("/settings");
    } catch (err) {
      setError((err as Error).message);
      setStage("error");
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="bg-surface-raised rounded-lg border border-white/5 p-8 max-w-lg w-full">
        {stage === "initial" && (
          <>
            <div className="flex items-center gap-3 mb-2">
              <div className="h-3 w-3 rounded-full bg-status-approved" />
              <h1 className="text-xl font-semibold">Account Connected</h1>
            </div>
            <p className="text-zinc-400 text-sm mb-1">{label}</p>
            <p className="text-white font-medium mb-6">{email}</p>
            <p className="text-sm text-zinc-400 mb-6">
              Train the voice model on this account&apos;s sent emails so drafts match your
              writing style from the first message. This analyzes up to 200 sent emails
              and takes about 30-60 seconds.
            </p>
            <div className="flex gap-3">
              <button
                onClick={train}
                className="flex-1 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-dim"
              >
                Train Voice
              </button>
              <button
                onClick={skip}
                className="flex-1 rounded-md border border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-400 transition-colors hover:border-white/20 hover:text-white"
              >
                Skip &amp; Activate
              </button>
            </div>
          </>
        )}

        {stage === "training" && (
          <div className="text-center py-4">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-accent mb-4" />
            <h2 className="text-lg font-semibold mb-2">Training voice model</h2>
            <p className="text-sm text-zinc-400">
              Analyzing sent emails from {email}...
            </p>
            <p className="text-xs text-zinc-500 mt-2">
              This may take 30-60 seconds. Do not close this page.
            </p>
          </div>
        )}

        {stage === "done" && result && (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-3 w-3 rounded-full bg-status-approved" />
              <h2 className="text-lg font-semibold">Voice training complete</h2>
            </div>
            <div className="space-y-2 mb-6">
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Emails imported</span>
                <span className="text-white font-medium">{result.imported}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Voice profile</span>
                <span className="text-white font-medium">{result.profile ? "Built" : "Skipped"}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Embeddings generated</span>
                <span className="text-white font-medium">{result.embeddingsGenerated}</span>
              </div>
            </div>
            <button
              onClick={() => router.push("/settings")}
              className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-dim"
            >
              Go to Settings
            </button>
          </>
        )}

        {stage === "error" && (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-3 w-3 rounded-full bg-status-action" />
              <h2 className="text-lg font-semibold">Something went wrong</h2>
            </div>
            <p className="text-sm text-zinc-400 mb-6 break-words">{error}</p>
            <div className="flex gap-3">
              <button
                onClick={train}
                className="flex-1 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-dim"
              >
                Retry
              </button>
              <button
                onClick={skip}
                className="flex-1 rounded-md border border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-400 transition-colors hover:border-white/20 hover:text-white"
              >
                Skip &amp; Activate
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function VoiceTrainPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-zinc-500">Loading...</div>
      </div>
    }>
      <VoiceTrainContent />
    </Suspense>
  );
}
