export type DockerContainer = {
  name: string;
  status: string;
  cpu_percent: number;
  memory_mb: number;
  memory_percent: number;
};

export type MinecraftStatus = {
  online: boolean;
  players_online: number;
  players_max: number;
  latency_ms: number;
};

export type CpuMetric = {
  percent: number;
  model?: string | null;
  cores_physical?: number | null;
  cores_logical?: number | null;
  frequency_mhz?: number | null;
};

export type MemoryMetric = {
  percent: number;
  used_gb?: number | null;
  total_gb?: number | null;
  available_gb?: number | null;
  model?: string | null;
};

export type GpuMetric = {
  percent?: number | null;
  used_gb?: number | null;
  total_gb?: number | null;
  model?: string | null;
  temperature_c?: number | null;
};

export type FanMetric = {
  label: string;
  rpm?: number | null;
  percent?: number | null;
  status?: string | null;
  model?: string | null;
};

export type MetricsResponse = {
  cpu: CpuMetric;
  mem: MemoryMetric;
  gpu?: GpuMetric | null;
  fans: FanMetric[];
  uptime_seconds: number;
  docker: DockerContainer[];
  minecraft?: MinecraftStatus | null;
  system_health: string;
  last_updated: string;
};