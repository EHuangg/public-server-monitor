import { MetricsResponse } from "@/lib/types";

function MetricBar({ label, value }: { label: string; value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm font-medium text-brownMuted">
        <span>{label}</span>
        <span className="text-brownInk">{clamped.toFixed(1)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-brownBorder/55">
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

export default function ServerHeartbeat({
  metrics,
  error
}: {
  metrics: MetricsResponse | null;
  error: string | null;
}) {
  const healthTone = (() => {
    if (!metrics) return "text-brownMuted";
    if (metrics.system_health === "All Systems Nominal") return "text-statusGood";
    return "text-statusWarn";
  })();

  return (
    <section className="mx-auto w-full max-w-3xl rounded-2xl border border-brownBorder/70 bg-creamCard/70 p-6 shadow-2xl shadow-brownMuted/10 backdrop-blur-sm md:p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-brownMuted">Server Heartbeat</p>
          <h1 className="mt-1 text-2xl font-semibold text-brownInk">Home Lab Snapshot</h1>
        </div>
        <span className={`rounded-full border border-current px-3 py-1 text-xs font-semibold uppercase tracking-wide ${healthTone}`}>
          {metrics?.system_health ?? "Initializing"}
        </span>
      </div>

      {error && <p className="mb-4 rounded-md border border-statusBad/30 bg-statusBad/10 px-3 py-2 text-sm text-brownInk">{error}</p>}

      {metrics ? (
        <div className="space-y-5">
          <MetricBar label="CPU" value={metrics.cpu.percent} />
          <MetricBar label="Memory" value={metrics.mem.percent} />

          <div className="grid gap-4 rounded-xl border border-brownBorder/70 bg-creamCard2/70 p-4 md:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wider text-brownMuted">Uptime</p>
              <p className="text-lg font-medium text-brownInk">{formatUptime(metrics.uptime_seconds)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-brownMuted">Last Updated</p>
              <p className="text-lg font-medium text-brownInk">{new Date(metrics.last_updated).toLocaleString()}</p>
            </div>
          </div>

          <div className="rounded-xl border border-brownBorder/70 bg-creamCard2/60 p-4">
            <p className="mb-3 text-xs uppercase tracking-wider text-brownMuted">Docker Containers</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {metrics.docker.length === 0 && <p className="text-sm text-brownMuted">No containers reported.</p>}
              {metrics.docker.map((container) => {
                const good = ["running", "up", "healthy"].includes(container.status.toLowerCase());
                return (
                  <div key={`${container.name}-${container.status}`} className="space-y-2 rounded-lg border border-brownBorder/70 bg-creamBg/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate pr-3 text-brownInk">{container.name}</span>
                      <span className={`rounded px-2 py-0.5 text-xs font-semibold ${good ? "bg-statusGood/15 text-statusGood" : "bg-statusWarn/15 text-brownInk"}`}>
                        {container.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-brownMuted">
                      <span>CPU {container.cpu_percent.toFixed(1)}%</span>
                      <span>RAM {formatMemoryMb(container.memory_mb)} ({container.memory_percent.toFixed(1)}%)</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {metrics.minecraft && (
            <div className="rounded-xl border border-brownBorder/70 bg-creamCard2/60 p-4">
              <p className="mb-2 text-xs uppercase tracking-wider text-brownMuted">Minecraft Server</p>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className={metrics.minecraft.online ? "text-statusGood" : "text-statusWarn"}>
                  {metrics.minecraft.online ? "Online" : "Offline"}
                </span>
                <span className="text-brownInk">
                  Players {metrics.minecraft.players_online}/{metrics.minecraft.players_max}
                </span>
                <span className="text-brownMuted">Latency {metrics.minecraft.latency_ms.toFixed(0)} ms</span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-brownBorder/70 bg-creamCard2/60 p-4 text-sm text-brownMuted">Awaiting first telemetry sample...</div>
      )}
    </section>
  );
}
