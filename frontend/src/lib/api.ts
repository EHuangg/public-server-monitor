import { MetricsResponse } from "@/lib/types";

export async function fetchMetrics(signal?: AbortSignal): Promise<MetricsResponse> {
  const response = await fetch("/api/metrics", {
    method: "GET",
    cache: "no-store",
    signal
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch metrics (${response.status})`);
  }

  return (await response.json()) as MetricsResponse;
}
