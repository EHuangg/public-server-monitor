from fastapi import APIRouter, HTTPException

from app.config import settings
from app.models.schemas import MetricsResponse
from app.services.cache import MetricsCache
from app.services.collector import fetch_sanitized_metrics

router = APIRouter(prefix="/api", tags=["metrics"])
cache = MetricsCache(ttl_seconds=settings.cache_ttl_seconds)


@router.get("/metrics", response_model=MetricsResponse)
async def get_metrics() -> MetricsResponse:
    cached = cache.get()
    if cached is not None:
        return cached

    try:
        fresh_metrics = await fetch_sanitized_metrics()
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=503, detail="Collector unavailable") from exc

    cache.set(fresh_metrics)
    return fresh_metrics
