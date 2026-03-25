from datetime import UTC, datetime
import re

import httpx
from mcstatus import JavaServer

from app.config import settings
from app.models.schemas import CpuMetric, DockerContainerMetric, MemoryMetric, MetricsResponse, MinecraftMetric


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
        cpu_percent = _to_float(item.get("cpu_percent") or item.get("cpu") or 0)
        memory_mb = _to_float(
            item.get("memory_mb")
            or item.get("mem")
            or item.get("memory")
            or item.get("memory_usage")
            or 0
        )
        memory_percent = _to_float(item.get("memory_percent") or item.get("mem_percent") or item.get("mem_pct") or 0)
        containers.append(
            DockerContainerMetric(
                name=name,
                status=status,
                cpu_percent=cpu_percent,
                memory_mb=memory_mb,
                memory_percent=memory_percent,
            )
        )

    return containers


def _parse_uptime_string(value: str) -> int:
    cleaned = value.strip()
    match = re.search(r"(?:(\d+)\s+days?,\s*)?(\d+):(\d+):(\d+)", cleaned)
    if not match:
        return 0

    days = int(match.group(1) or 0)
    hours = int(match.group(2))
    minutes = int(match.group(3))
    seconds = int(match.group(4))
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def _extract_uptime_seconds(payload: dict) -> int:
    quicklook = payload.get("quicklook", {}) if isinstance(payload.get("quicklook", {}), dict) else {}

    candidates: list[object] = [
        payload.get("uptime"),
        payload.get("uptime_seconds"),
        quicklook.get("uptime"),
        quicklook.get("uptime_seconds"),
    ]

    for candidate in candidates:
        if isinstance(candidate, (int, float)):
            return _to_int(candidate)
        if isinstance(candidate, str):
            parsed = _parse_uptime_string(candidate)
            if parsed > 0:
                return parsed

    return 0


def _extract_minecraft_status() -> MinecraftMetric | None:
    if not settings.minecraft_host:
        return None

    try:
        server = JavaServer.lookup(f"{settings.minecraft_host}:{settings.minecraft_port}")
        status = server.status(timeout=settings.minecraft_timeout_seconds)
        players_online = int(getattr(status.players, "online", 0) or 0)
        players_max = int(getattr(status.players, "max", 0) or 0)
        latency_ms = _to_float(getattr(status, "latency", 0.0))
        return MinecraftMetric(
            online=True,
            players_online=players_online,
            players_max=players_max,
            latency_ms=latency_ms,
        )
    except Exception:
        return MinecraftMetric(online=False, players_online=0, players_max=0, latency_ms=0)


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
    uptime_seconds = _extract_uptime_seconds(payload if isinstance(payload, dict) else {})
    containers = _extract_docker_containers(payload if isinstance(payload, dict) else {})
    minecraft = _extract_minecraft_status()
    health = _calculate_health(cpu_percent=cpu_percent, mem_percent=mem_percent, containers=containers)

    return MetricsResponse(
        cpu=CpuMetric(percent=cpu_percent),
        mem=MemoryMetric(percent=mem_percent),
        uptime_seconds=uptime_seconds,
        docker=containers,
        minecraft=minecraft,
        system_health=health,
        last_updated=datetime.now(UTC),
    )
