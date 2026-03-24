from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.models.schemas import MetricsResponse


@dataclass
class CacheItem:
    data: MetricsResponse
    expires_at: datetime


class MetricsCache:
    def __init__(self, ttl_seconds: int) -> None:
        self._ttl_seconds = ttl_seconds
        self._item: CacheItem | None = None

    def get(self) -> MetricsResponse | None:
        if not self._item:
            return None

        if self._item.expires_at <= datetime.now(UTC):
            self._item = None
            return None

        return self._item.data

    def set(self, data: MetricsResponse) -> None:
        self._item = CacheItem(
            data=data,
            expires_at=datetime.now(UTC) + timedelta(seconds=self._ttl_seconds),
        )
