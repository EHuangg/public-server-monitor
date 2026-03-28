from datetime import datetime

from pydantic import BaseModel


class TemperatureMetric(BaseModel):
    label: str
    celsius: float


class CpuMetric(BaseModel):
    percent: float
    model: str | None = None
    cores_physical: int | None = None
    cores_logical: int | None = None
    frequency_mhz: float | None = None
    temperatures: list[TemperatureMetric] = []


class MemoryMetric(BaseModel):
    percent: float
    used_gb: float | None = None
    total_gb: float | None = None
    available_gb: float | None = None
    model: str | None = None


class GpuMetric(BaseModel):
    percent: float | None = None
    used_gb: float | None = None
    total_gb: float | None = None
    model: str | None = None
    temperature_c: float | None = None


class FanMetric(BaseModel):
    label: str
    rpm: float | None = None
    percent: float | None = None
    status: str | None = None
    model: str | None = None


class DockerContainerMetric(BaseModel):
    name: str
    status: str
    cpu_percent: float
    memory_mb: float
    memory_percent: float


class MinecraftMetric(BaseModel):
    online: bool
    players_online: int
    players_max: int
    latency_ms: float


class MetricsResponse(BaseModel):
    cpu: CpuMetric
    mem: MemoryMetric
    gpu: GpuMetric | None = None
    fans: list[FanMetric]
    uptime_seconds: int
    docker: list[DockerContainerMetric]
    minecraft: MinecraftMetric | None = None
    system_health: str
    last_updated: datetime