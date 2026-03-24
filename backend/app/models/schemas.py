from datetime import datetime

from pydantic import BaseModel, Field


class CpuMetric(BaseModel):
    percent: float = Field(ge=0, le=100)


class MemoryMetric(BaseModel):
    percent: float = Field(ge=0, le=100)


class DockerContainerMetric(BaseModel):
    name: str
    status: str


class MetricsResponse(BaseModel):
    cpu: CpuMetric
    mem: MemoryMetric
    uptime_seconds: int = Field(ge=0)
    docker: list[DockerContainerMetric]
    system_health: str
    last_updated: datetime
