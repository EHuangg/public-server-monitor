import type { MetricsResponse } from "@/lib/types";

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs uppercase tracking-wider text-brownMuted">{label}</span>
      <span className="truncate text-sm font-medium text-brownInk">{value}</span>
    </div>
  );
}

export default function Sidebar({ metrics }: { metrics: MetricsResponse | null }) {
  const docker = metrics?.docker ?? [];
  const runningCount = docker.filter((c) => ["running", "up", "healthy"].includes(c.status.toLowerCase())).length;
  const degradedCount = docker.length - runningCount;

  return (
    <aside className="w-full shrink-0 space-y-4 border-b border-brownBorder/70 bg-creamCard/70 p-4 backdrop-blur-sm md:h-[calc(100vh-0px)] md:w-80 md:border-b-0 md:border-r md:p-6">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-brownMuted">Menu</p>
        <h2 className="mt-1 text-lg font-semibold text-brownInk">Server Monitor</h2>
      </div>

      <div className="rounded-xl border border-brownBorder/70 bg-creamBg/70 p-4">
        <p className="mb-3 text-xs uppercase tracking-wider text-brownMuted">Device stats</p>
        {metrics ? (
          <div className="space-y-2">
            <StatRow label="CPU" value={`${metrics.cpu.percent.toFixed(1)}%`} />
            <StatRow label="Memory" value={`${metrics.mem.percent.toFixed(1)}%`} />
            <StatRow label="Uptime" value={formatUptime(metrics.uptime_seconds)} />
            <StatRow label="Updated" value={new Date(metrics.last_updated).toLocaleTimeString()} />
          </div>
        ) : (
          <p className="text-sm text-brownMuted">Waiting for telemetry…</p>
        )}
      </div>

      <div className="rounded-xl border border-brownBorder/70 bg-creamBg/70 p-4">
        <p className="mb-3 text-xs uppercase tracking-wider text-brownMuted">Service stats</p>
        {metrics ? (
          <div className="space-y-2">
            <StatRow label="Containers" value={`${docker.length}`} />
            <StatRow label="Running" value={`${runningCount}`} />
            <StatRow label="Degraded" value={`${Math.max(0, degradedCount)}`} />
            <StatRow label="Minecraft" value={metrics.minecraft ? (metrics.minecraft.online ? "Online" : "Offline") : "Not configured"} />
          </div>
        ) : (
          <p className="text-sm text-brownMuted">Waiting for telemetry…</p>
        )}
      </div>
    </aside>
  );
}

