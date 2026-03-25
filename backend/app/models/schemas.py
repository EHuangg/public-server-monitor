from datetime import datetime

from pydantic import BaseModel, Field


class CpuMetric(BaseModel):
    percent: float = Field(ge=0, le=100)


class MemoryMetric(BaseModel):
    percent: float = Field(ge=0, le=100)


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
    uptime_seconds: int = Field(ge=0)
    docker: list[DockerContainerMetric]
    minecraft: MinecraftMetric | None = None
    system_health: str
    last_updated: datetime
