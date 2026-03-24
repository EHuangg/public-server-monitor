from datetime import UTC, datetime

import httpx

from app.config import settings
from app.models.schemas import CpuMetric, DockerContainerMetric, MemoryMetric, MetricsResponse


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_int(value: object, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _extract_docker_containers(payload: dict) -> list[DockerContainerMetric]:
    docker_payload = payload.get("docker", [])

    if isinstance(docker_payload, dict):
        candidates = docker_payload.get("containers", [])
    elif isinstance(docker_payload, list):
        candidates = docker_payload
    else:
        candidates = []

    containers: list[DockerContainerMetric] = []
    for item in candidates:
        if not isinstance(item, dict):
            continue

        name = str(item.get("name") or item.get("container_name") or "unknown")
        status = str(item.get("status") or item.get("state") or "unknown")
        containers.append(DockerContainerMetric(name=name, status=status))

    return containers


def _calculate_health(cpu_percent: float, mem_percent: float, containers: list[DockerContainerMetric]) -> str:
    stopped_container = any(c.status.lower() not in {"running", "up", "healthy"} for c in containers)
    high_usage = cpu_percent >= 90 or mem_percent >= 90

    if stopped_container or high_usage:
        return "Degraded"

    return "All Systems Nominal"


async def fetch_sanitized_metrics() -> MetricsResponse:
    url = f"{settings.glances_base_url.rstrip('/')}{settings.glances_endpoint}"

    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
        response = await client.get(url)
        response.raise_for_status()
        payload = response.json()

    cpu_data = payload.get("cpu", {}) if isinstance(payload, dict) else {}
    mem_data = payload.get("mem", {}) if isinstance(payload, dict) else {}

    cpu_percent = _to_float(cpu_data.get("total") if isinstance(cpu_data, dict) else 0)
    mem_percent = _to_float(mem_data.get("percent") if isinstance(mem_data, dict) else 0)
    uptime_seconds = _to_int(payload.get("uptime") if isinstance(payload, dict) else 0)
    containers = _extract_docker_containers(payload if isinstance(payload, dict) else {})
    health = _calculate_health(cpu_percent=cpu_percent, mem_percent=mem_percent, containers=containers)

    return MetricsResponse(
        cpu=CpuMetric(percent=cpu_percent),
        mem=MemoryMetric(percent=mem_percent),
        uptime_seconds=uptime_seconds,
        docker=containers,
        system_health=health,
        last_updated=datetime.now(UTC),
    )
