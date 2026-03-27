"use client";

import { useEffect, useState } from "react";

import ServerCaseBlueprint from "@/components/ServerCaseBlueprint";
import { fetchMetrics } from "@/lib/api";
import type { MetricsResponse } from "@/lib/types";

const POLL_INTERVAL_MS = Number(
  process.env.NEXT_PUBLIC_POLL_INTERVAL_MS ?? "5000"
);

export default function Page() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      const controller = new AbortController();

      try {
        const data = await fetchMetrics(controller.signal);
        if (!mounted) return;
        setMetrics(data);
      } catch {
        if (!mounted) return;
      }
    };

    load();
    timer = setInterval(load, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  return <ServerCaseBlueprint metrics={metrics} />;
}