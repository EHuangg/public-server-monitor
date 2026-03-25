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

export type MetricsResponse = {
  cpu: { percent: number };
  mem: { percent: number };
  uptime_seconds: number;
  docker: DockerContainer[];
  minecraft?: MinecraftStatus | null;
  system_health: string;
  last_updated: string;
};
