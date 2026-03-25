"use client";

import { useEffect, useMemo, useState } from "react";

import { fetchMetrics } from "@/lib/api";
import { MetricsResponse } from "@/lib/types";

const POLL_INTERVAL_MS = Number(process.env.NEXT_PUBLIC_POLL_INTERVAL_MS ?? "5000");

function MetricBar({ label, value }: { label: string; value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm font-medium text-slate-200">
        <span>{label}</span>
        <span>{clamped.toFixed(1)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-700/70">
        <div
          className={`h-full rounded-full transition-all duration-500 ${clamped >= 90 ? "bg-statusBad" : clamped >= 70 ? "bg-statusWarn" : "bg-statusGood"}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function formatMemoryMb(value: number): string {
  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)} GB`;
  }
  return `${value.toFixed(0)} MB`;
}

export default function ServerHeartbeat() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      const controller = new AbortController();
      try {
        const data = await fetchMetrics(controller.signal);
        if (!mounted) {
          return;
        }
        setMetrics(data);
        setError(null);
      } catch {
        if (!mounted) {
          return;
        }
        setError("Telemetry stream is temporarily unavailable.");
      }
    };

    load();
    timer = setInterval(load, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      if (timer) {
        clearInterval(timer);
      }
    };
  }, []);

  const healthTone = useMemo(() => {
    if (!metrics) return "text-slate-300";
    if (metrics.system_health === "All Systems Nominal") return "text-statusGood";
    return "text-statusWarn";
  }, [metrics]);

  return (
    <section className="mx-auto w-full max-w-3xl rounded-2xl border border-slate-500/30 bg-slateNight/70 p-6 shadow-2xl shadow-slate-900/40 backdrop-blur-sm md:p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-slate-300">Server Heartbeat</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-100">Home Lab NOC Snapshot</h1>
        </div>
        <span className={`rounded-full border border-current px-3 py-1 text-xs font-semibold uppercase tracking-wide ${healthTone}`}>
          {metrics?.system_health ?? "Initializing"}
        </span>
      </div>

      {error && <p className="mb-4 rounded-md border border-statusBad/40 bg-statusBad/10 px-3 py-2 text-sm text-red-100">{error}</p>}

      {metrics ? (
        <div className="space-y-5">
          <MetricBar label="CPU" value={metrics.cpu.percent} />
          <MetricBar label="Memory" value={metrics.mem.percent} />

          <div className="grid gap-4 rounded-xl border border-slate-500/30 bg-slate-900/50 p-4 md:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-400">Uptime</p>
              <p className="text-lg font-medium text-slate-100">{formatUptime(metrics.uptime_seconds)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-400">Last Updated</p>
              <p className="text-lg font-medium text-slate-100">{new Date(metrics.last_updated).toLocaleString()}</p>
            </div>
          </div>

          <div className="rounded-xl border border-slate-500/30 bg-slate-900/45 p-4">
            <p className="mb-3 text-xs uppercase tracking-wider text-slate-400">Docker Containers</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {metrics.docker.length === 0 && <p className="text-sm text-slate-300">No containers reported.</p>}
              {metrics.docker.map((container) => {
                const good = ["running", "up", "healthy"].includes(container.status.toLowerCase());
                return (
                  <div key={`${container.name}-${container.status}`} className="space-y-2 rounded-lg border border-slate-600/60 bg-slate-800/65 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate pr-3 text-slate-100">{container.name}</span>
                      <span className={`rounded px-2 py-0.5 text-xs font-semibold ${good ? "bg-statusGood/20 text-emerald-300" : "bg-statusWarn/20 text-amber-300"}`}>
                        {container.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-300">
                      <span>CPU {container.cpu_percent.toFixed(1)}%</span>
                      <span>RAM {formatMemoryMb(container.memory_mb)} ({container.memory_percent.toFixed(1)}%)</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {metrics.minecraft && (
            <div className="rounded-xl border border-slate-500/30 bg-slate-900/45 p-4">
              <p className="mb-2 text-xs uppercase tracking-wider text-slate-400">Minecraft Server</p>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className={metrics.minecraft.online ? "text-emerald-300" : "text-amber-300"}>
                  {metrics.minecraft.online ? "Online" : "Offline"}
                </span>
                <span className="text-slate-200">
                  Players {metrics.minecraft.players_online}/{metrics.minecraft.players_max}
                </span>
                <span className="text-slate-300">Latency {metrics.minecraft.latency_ms.toFixed(0)} ms</span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-500/30 bg-slate-900/45 p-4 text-sm text-slate-300">Awaiting first telemetry sample...</div>
      )}
    </section>
  );
}
