import json
import re
import subprocess
from datetime import UTC, datetime

import httpx
from mcstatus import JavaServer

from app.config import settings
from app.models.schemas import (
    CpuMetric,
    DockerContainerMetric,
    FanMetric,
    GpuMetric,
    MemoryMetric,
    MetricsResponse,
    MinecraftMetric,
)

PRIVATE_IPV4_PATTERN = re.compile(
    r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
    r"192\.168\.\d{1,3}\.\d{1,3}|"
    r"172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b"
)
UUID_PATTERN = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b"
)
ABS_PATH_PATTERN = re.compile(r"(?:[A-Za-z]:\\[^\s]+|/[^\s]+)")


def _sanitize_text(value: object) -> str:
    text = str(value)
    text = PRIVATE_IPV4_PATTERN.sub("[private-ip]", text)
    text = UUID_PATTERN.sub("[uuid]", text)
    text = ABS_PATH_PATTERN.sub("[path]", text)
    return text


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_float_or_none(value: object) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: object, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _clamp_percent(value: object) -> float:
    return max(0.0, min(100.0, _to_float(value)))


def _clamp_percent_or_none(value: object) -> float | None:
    parsed = _to_float_or_none(value)
    if parsed is None:
        return None
    return max(0.0, min(100.0, parsed))


def _bytes_to_gb(value: object) -> float | None:
    parsed = _to_float_or_none(value)
    if parsed is None:
        return None
    if parsed < 0:
        return None
    return round(parsed / (1024**3), 2)


def _mhz_from_hz_or_mhz(value: object) -> float | None:
    parsed = _to_float_or_none(value)
    if parsed is None or parsed < 0:
        return None

    if parsed > 1_000_000:
        return round(parsed / 1_000_000, 2)

    return round(parsed, 2)


def _first_present(dct: dict, keys: list[str]) -> object | None:
    for key in keys:
        if key in dct and dct[key] is not None:
            return dct[key]
    return None


def _run_command(cmd: list[str]) -> str | None:
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if result.returncode != 0:
            return None
        return result.stdout.strip() or None
    except Exception:
        return None


def _read_file(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return None


def _fallback_cpu_model() -> str | None:
    lscpu_json = _run_command(["lscpu", "-J"])
    if lscpu_json:
        try:
            data = json.loads(lscpu_json)
            for row in data.get("lscpu", []):
                field = str(row.get("field", "")).strip().rstrip(":")
                if field == "Model name":
                    value = str(row.get("data", "")).strip()
                    if value:
                        return _sanitize_text(value)
        except Exception:
            pass

    cpuinfo = _read_file("/host_proc/cpuinfo") or _read_file("/proc/cpuinfo")
    if cpuinfo:
        for line in cpuinfo.splitlines():
            if line.lower().startswith("model name"):
                parts = line.split(":", 1)
                if len(parts) == 2 and parts[1].strip():
                    return _sanitize_text(parts[1].strip())

    return None


def _fallback_cpu_frequency_mhz() -> float | None:
    current_freq = (
        _read_file("/host_sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq")
        or _read_file("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq")
    )
    if current_freq:
        try:
            return round(float(current_freq) / 1000.0, 2)
        except (TypeError, ValueError):
            pass

    lscpu_output = _run_command(["lscpu"])
    if lscpu_output:
        for line in lscpu_output.splitlines():
            if "CPU MHz" in line or "CPU max MHz" in line:
                parts = line.split(":", 1)
                if len(parts) == 2:
                    parsed = _to_float_or_none(parts[1].strip())
                    if parsed is not None:
                        return round(parsed, 2)

    cpuinfo = _read_file("/host_proc/cpuinfo") or _read_file("/proc/cpuinfo")
    if cpuinfo:
        for line in cpuinfo.splitlines():
            if line.lower().startswith("cpu mhz"):
                parts = line.split(":", 1)
                if len(parts) == 2:
                    parsed = _to_float_or_none(parts[1].strip())
                    if parsed is not None:
                        return round(parsed, 2)

    return None


def _fallback_nvidia_gpu() -> GpuMetric | None:
    output = _run_command(
        [
            "nvidia-smi",
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
        ]
    )
    if not output:
        return None

    line = output.splitlines()[0]
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < 5:
        return None

    name, util, mem_used_mb, mem_total_mb, temp_c = parts[:5]

    used_gb = None
    total_gb = None

    used_mb_val = _to_float_or_none(mem_used_mb)
    total_mb_val = _to_float_or_none(mem_total_mb)

    if used_mb_val is not None:
        used_gb = round(used_mb_val / 1024.0, 2)
    if total_mb_val is not None:
        total_gb = round(total_mb_val / 1024.0, 2)

    temperature_c = _to_float_or_none(temp_c)
    if temperature_c is not None:
        temperature_c = round(max(0.0, temperature_c), 2)

    return GpuMetric(
        percent=_clamp_percent_or_none(util),
        used_gb=used_gb,
        total_gb=total_gb,
        model=_sanitize_text(name) if name else None,
        temperature_c=temperature_c,
    )


def _fallback_amd_gpu() -> GpuMetric | None:
    busy = _read_file("/host_sys/class/drm/card0/device/gpu_busy_percent")
    vram_used = _read_file("/host_sys/class/drm/card0/device/mem_info_vram_used")
    vram_total = _read_file("/host_sys/class/drm/card0/device/mem_info_vram_total")
    product_name = _read_file("/host_sys/class/drm/card0/device/product_name")

    temperature_c = None
    for path in [
        "/host_sys/class/drm/card0/device/hwmon/hwmon0/temp1_input",
        "/host_sys/class/hwmon/hwmon0/temp1_input",
        "/sys/class/drm/card0/device/hwmon/hwmon0/temp1_input",
        "/sys/class/hwmon/hwmon0/temp1_input",
    ]:
        raw = _read_file(path)
        if raw is not None:
            parsed = _to_float_or_none(raw)
            if parsed is not None:
                temperature_c = round(parsed / 1000.0, 2)
                break

    if not any([busy, vram_used, vram_total, product_name]):
        return None

    return GpuMetric(
        percent=_clamp_percent_or_none(busy),
        used_gb=_bytes_to_gb(vram_used),
        total_gb=_bytes_to_gb(vram_total),
        model=_sanitize_text(product_name) if product_name else "AMD GPU",
        temperature_c=temperature_c,
    )
    

def _extract_docker_containers(payload: dict) -> list[DockerContainerMetric]:
    docker_payload = payload.get("docker", None)
    if docker_payload is None:
        docker_payload = payload.get("containers", [])

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

        name = _sanitize_text(item.get("name") or item.get("container_name") or "unknown")
        status = _sanitize_text(item.get("status") or item.get("state") or "unknown")
        cpu_percent = _to_float(item.get("cpu_percent") or item.get("cpu") or 0)
        memory_mb = _to_float(
            item.get("memory_mb")
            or item.get("mem")
            or item.get("memory")
            or item.get("memory_usage")
            or 0
        )
        memory_percent = _to_float(
            item.get("memory_percent") or item.get("mem_percent") or item.get("mem_pct") or 0
        )

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
    quicklook = payload.get("quicklook", {})
    quicklook = quicklook if isinstance(quicklook, dict) else {}

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
        return MinecraftMetric(
            online=False,
            players_online=0,
            players_max=0,
            latency_ms=0,
        )


def _extract_cpu_metric(payload: dict) -> CpuMetric:
    cpu_data = payload.get("cpu", {})
    cpu_data = cpu_data if isinstance(cpu_data, dict) else {}

    cpuinfo_data = payload.get("cpuinfo", {})
    cpuinfo_data = cpuinfo_data if isinstance(cpuinfo_data, dict) else {}

    percent = _clamp_percent(_first_present(cpu_data, ["total", "user", "percent"]))

    model = _first_present(
        cpuinfo_data,
        ["brand", "model", "model_name", "cpu_model", "name"],
    )
    model_str = _sanitize_text(model) if model is not None else _fallback_cpu_model()

    cores_logical = _to_int(
        _first_present(cpuinfo_data, ["cpu_cores", "logical_cores", "cpucore"])
        or _first_present(cpu_data, ["cpucore"]),
        default=0,
    )
    if cores_logical <= 0:
        cores_logical = None

    cores_physical = _to_int(
        _first_present(cpuinfo_data, ["physical_cores", "core", "cores"]),
        default=0,
    )
    if cores_physical <= 0:
        cores_physical = None

    frequency_mhz = _mhz_from_hz_or_mhz(
        _first_present(cpuinfo_data, ["hz_current", "current", "cpu_hz"])
        or _first_present(cpu_data, ["hz_current", "freq", "frequency"])
    )
    if frequency_mhz is None:
        frequency_mhz = _fallback_cpu_frequency_mhz()

    return CpuMetric(
        percent=percent,
        model=model_str,
        cores_physical=cores_physical,
        cores_logical=cores_logical,
        frequency_mhz=frequency_mhz,
    )


def _extract_memory_metric(payload: dict) -> MemoryMetric:
    mem_data = payload.get("mem", {})
    mem_data = mem_data if isinstance(mem_data, dict) else {}

    percent = _clamp_percent(_first_present(mem_data, ["percent"]))

    used_gb = _bytes_to_gb(_first_present(mem_data, ["used", "memory_usage"]))
    total_gb = _bytes_to_gb(_first_present(mem_data, ["total"]))
    available_gb = _bytes_to_gb(_first_present(mem_data, ["available", "free"]))

    model = None

    return MemoryMetric(
        percent=percent,
        used_gb=used_gb,
        total_gb=total_gb,
        available_gb=available_gb,
        model=model,
    )


def _extract_gpu_metric(payload: dict) -> GpuMetric | None:
    raw_gpu = payload.get("gpu")

    candidate: dict | None = None
    if isinstance(raw_gpu, list) and raw_gpu:
        first = raw_gpu[0]
        if isinstance(first, dict):
            candidate = first
    elif isinstance(raw_gpu, dict):
        candidate = raw_gpu

    if candidate is not None:
        model = _first_present(candidate, ["model", "name", "gpu_name"])
        model_str = _sanitize_text(model) if model is not None else None

        percent = _clamp_percent_or_none(
            _first_present(candidate, ["percent", "gpu_util", "utilization", "proc"])
        )

        used_gb = _bytes_to_gb(
            _first_present(candidate, ["memory_used", "mem_used", "used_memory"])
        )
        total_gb = _bytes_to_gb(
            _first_present(candidate, ["memory_total", "mem_total", "total_memory"])
        )

        if used_gb is None:
            mem_used_raw = _to_float_or_none(
                _first_present(candidate, ["memory_used_mb", "mem_used_mb"])
            )
            if mem_used_raw is not None:
                used_gb = round(mem_used_raw / 1024, 2)

        if total_gb is None:
            mem_total_raw = _to_float_or_none(
                _first_present(candidate, ["memory_total_mb", "mem_total_mb"])
            )
            if mem_total_raw is not None:
                total_gb = round(mem_total_raw / 1024, 2)

        temperature_c = _to_float_or_none(
            _first_present(candidate, ["temperature", "temp", "temperature_c"])
        )
        if temperature_c is not None:
            temperature_c = round(max(0.0, temperature_c), 2)

        return GpuMetric(
            percent=percent,
            used_gb=used_gb,
            total_gb=total_gb,
            model=model_str,
            temperature_c=temperature_c,
        )

    return _fallback_nvidia_gpu() or _fallback_amd_gpu()


def _extract_fans(payload: dict) -> list[FanMetric]:
    sensors = payload.get("sensors")
    candidates: list[dict] = []

    if isinstance(sensors, list):
        candidates = [item for item in sensors if isinstance(item, dict)]
    elif isinstance(sensors, dict):
        for value in sensors.values():
            if isinstance(value, list):
                candidates.extend([item for item in value if isinstance(item, dict)])
            elif isinstance(value, dict):
                candidates.append(value)

    fans: list[FanMetric] = []
    for item in candidates:
        label_value = _first_present(item, ["label", "name", "sensor", "key"])
        label = _sanitize_text(label_value) if label_value is not None else "fan"

        status_value = _first_present(item, ["status", "state"])
        model_value = _first_present(item, ["model"])

        text_blob = " ".join(
            str(v) for v in [label_value, status_value, model_value] if v is not None
        ).lower()

        rpm = _to_float_or_none(_first_present(item, ["rpm", "speed_rpm", "fan_rpm"]))
        percent = _clamp_percent_or_none(_first_present(item, ["percent", "pct"]))

        looks_like_fan = (
            "fan" in text_blob
            or "rpm" in text_blob
            or any(k in item for k in ["rpm", "speed_rpm", "fan_rpm"])
        )

        looks_like_temp_sensor = any(
            bad in text_blob
            for bad in [
                "core ",
                "package id",
                "temp",
                "junction",
                "edge",
                "tctl",
                "tdie",
                "radeon",
                "gpu",
            ]
        )

        if not looks_like_fan or looks_like_temp_sensor:
            continue

        if rpm is None and percent is None:
            continue

        fans.append(
            FanMetric(
                label=label,
                rpm=round(rpm, 2) if rpm is not None else None,
                percent=percent,
                status=_sanitize_text(status_value) if status_value is not None else None,
                model=_sanitize_text(model_value) if model_value is not None else None,
            )
        )

    return fans


def _calculate_health(
    cpu_percent: float,
    mem_percent: float,
    containers: list[DockerContainerMetric],
) -> str:
    stopped_container = any(
        c.status.lower() not in {"running", "up", "healthy"} for c in containers
    )
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

    payload = payload if isinstance(payload, dict) else {}

    cpu = _extract_cpu_metric(payload)
    mem = _extract_memory_metric(payload)
    gpu = _extract_gpu_metric(payload)
    fans = _extract_fans(payload)
    uptime_seconds = _extract_uptime_seconds(payload)
    containers = _extract_docker_containers(payload)
    minecraft = _extract_minecraft_status()
    health = _calculate_health(
        cpu_percent=cpu.percent,
        mem_percent=mem.percent,
        containers=containers,
    )

    return MetricsResponse(
        cpu=cpu,
        mem=mem,
        gpu=gpu,
        fans=fans,
        uptime_seconds=uptime_seconds,
        docker=containers,
        minecraft=minecraft,
        system_health=health,
        last_updated=datetime.now(UTC),
    )