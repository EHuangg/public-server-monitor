from datetime import datetime

from pydantic import BaseModel, Field


class CpuMetric(BaseModel):
    percent: float = Field(ge=0, le=100)
    model: str | None = None
    cores_physical: int | None = Field(default=None, ge=1)
    cores_logical: int | None = Field(default=None, ge=1)
    frequency_mhz: float | None = Field(default=None, ge=0)


class MemoryMetric(BaseModel):
    percent: float = Field(ge=0, le=100)
    used_gb: float | None = Field(default=None, ge=0)
    total_gb: float | None = Field(default=None, ge=0)
    available_gb: float | None = Field(default=None, ge=0)
    model: str | None = None


class GpuMetric(BaseModel):
    percent: float | None = Field(default=None, ge=0, le=100)
    used_gb: float | None = Field(default=None, ge=0)
    total_gb: float | None = Field(default=None, ge=0)
    model: str | None = None
    temperature_c: float | None = Field(default=None, ge=0)


class FanMetric(BaseModel):
    label: str
    rpm: float | None = Field(default=None, ge=0)
    percent: float | None = Field(default=None, ge=0, le=100)
    status: str | None = None
    model: str | None = None


class DockerContainerMetric(BaseModel):
    name: str
    status: str
    cpu_percent: float = Field(default=0, ge=0)
    memory_mb: float = Field(default=0, ge=0)
    memory_percent: float = Field(default=0, ge=0)


class MinecraftMetric(BaseModel):
    online: bool
    players_online: int = Field(default=0, ge=0)
    players_max: int = Field(default=0, ge=0)
    latency_ms: float = Field(default=0, ge=0)


class MetricsResponse(BaseModel):
    cpu: CpuMetric
    mem: MemoryMetric
    gpu: GpuMetric | None = None
    fans: list[FanMetric] = Field(default_factory=list)
    uptime_seconds: int = Field(ge=0)
    docker: list[DockerContainerMetric]
    minecraft: MinecraftMetric | None = None
    system_health: str
    last_updated: datetime