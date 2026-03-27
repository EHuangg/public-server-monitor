"use client";

import { useEffect, useState } from "react";

import ServerCaseBlueprint from "@/components/ServerCaseBlueprint";
import ServerHeartbeat from "@/components/ServerHeartbeat";
import Sidebar from "@/components/Sidebar";
import { fetchMetrics } from "@/lib/api";
import type { MetricsResponse } from "@/lib/types";

const POLL_INTERVAL_MS = Number(process.env.NEXT_PUBLIC_POLL_INTERVAL_MS ?? "5000");

export default function Dashboard() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      const controller = new AbortController();
      try {
        const data = await fetchMetrics(controller.signal);
        if (!mounted) return;
        setMetrics(data);
        setError(null);
      } catch {
        if (!mounted) return;
        setError("Telemetry stream is temporarily unavailable.");
      }
    };

    load();
    timer = setInterval(load, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  return (
    <div className="min-h-screen w-full">
      <main className="md:flex">
        <Sidebar metrics={metrics} />
        <div className="flex-1 p-4 md:p-10">
          <ServerHeartbeat metrics={metrics} error={error} />
        </div>
      </main>
      <ServerCaseBlueprint metrics={metrics} />
    </div>
  );
}

