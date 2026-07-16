"use client";

import dynamic from "next/dynamic";
import { useSession } from "next-auth/react";
import { use } from "react";

const RunGraph = dynamic(() => import("@/components/runs/RunGraph"), { ssr: false });

export default function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session } = useSession();

  if (!session) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-49px)] text-zinc-500 text-sm">
        Sign in to view runs
      </div>
    );
  }

  return <RunGraph runId={id} />;
}
