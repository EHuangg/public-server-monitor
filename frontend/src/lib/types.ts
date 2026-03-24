export type DockerContainer = {
  name: string;
  status: string;
};

export type MetricsResponse = {
  cpu: { percent: number };
  mem: { percent: number };
  uptime_seconds: number;
  docker: DockerContainer[];
  system_health: string;
  last_updated: string;
};
