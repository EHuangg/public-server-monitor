"use client";

import { createTimeline } from "animejs";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  Box3,
  Color,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { projectWorldToScreen } from "@/lib/three/projectToScreen";
import {
  CASE_OBJECT_NAMES,
  collectCaseParts,
  getExplodeWorldDirection,
} from "@/lib/serverCaseConfig";
import type { MetricsResponse } from "@/lib/types";

const MODEL_URL =
  process.env.NEXT_PUBLIC_SERVER_CASE_GLB ?? "/models/server-case.glb";

/**
 * Keep the current working scene behavior.
 * Do not "correct" axes beyond the overrides below.
 */
const WORLD_UP = new Vector3(0, 0, 1);
const DVD_FORWARD_AXIS = new Vector3(1, 0, 0);
const DVD_TRAY_AXIS = new Vector3(0, 1, 0);

const HOVER_PARTS: Record<string, number> = {
  RAM: 0.04,
  RAM001: 0.04,
  RAM002: 0.04,
  RAM003: 0.04,
  CPU: 0.05,
  CPU001: 0.08,
  GPUBase: 0.035,
  GPUBase001: 0.035,
  GPUFan: 0.03,
};

const RAM_PART_NAMES = ["RAM", "RAM001", "RAM002", "RAM003"];
const CPU_PART_NAMES = ["CPU", "CPU001"];
const MOTHERBOARD_PART_NAMES = ["MotherBoard"];
const GPU_PART_NAMES = ["GPUBase", "GPUBase001", "GPUFan"];
const GPU_FAN_NAMES = ["GPUFan"];
const GPU_FAN_SPIN_SPEED = 8;

const DVD_PREROLL_DIST = 0.5;
const DVD_TRAY_DIST = 0.08;
const STOP_DISTANCE_MULT = 2.2;

const DVD_PREROLL_END = 0.2;

const GROUP_DURATION = 0.24;
const GROUP_OFFSET = GROUP_DURATION * 0.25;

const GROUP_2_START = 0.0667;
const GROUP_2_END = GROUP_2_START + GROUP_DURATION;

const GROUP_1_START = GROUP_2_START - GROUP_OFFSET;
const GROUP_1_END = GROUP_1_START + GROUP_DURATION;

const GROUP_3_START = GROUP_2_START + GROUP_OFFSET;
const GROUP_3_END = GROUP_3_START + GROUP_DURATION;

const GROUP_4_START = GROUP_3_START + GROUP_OFFSET;
const GROUP_4_END = GROUP_4_START + GROUP_DURATION;

const GROUP_5_START = GROUP_4_START + GROUP_OFFSET;
const GROUP_5_END = GROUP_5_START + GROUP_DURATION;

const GROUP_6_START = GROUP_5_START + GROUP_OFFSET;
const GROUP_6_END = GROUP_6_START + GROUP_DURATION;
const FINAL_ANIMATION_PROGRESS = Math.min(0.995, GROUP_6_END + 0.06);

const MIN_VISIBLE_SCALE = 0.0001;
const PANEL_WIDTH = 240;
const PANEL_MARGIN = 24;
const CONNECTOR_GAP = 20;
const PANEL_REVEAL_DURATION = 0.1;

type PanelKey = "cpu" | "ram" | "gpu";
type Point = { x: number; y: number };
type PanelPosition = { x: number; y: number };
type ScreenAnchor = { x: number; y: number; visible: boolean };
type PanelConfig = {
  key: PanelKey;
  partNames: string[];
  revealStart: number;
};

const PANEL_CONFIGS: PanelConfig[] = [
  { key: "cpu", partNames: CPU_PART_NAMES, revealStart: GROUP_2_START },
  { key: "ram", partNames: RAM_PART_NAMES, revealStart: GROUP_2_START },
  { key: "gpu", partNames: GPU_PART_NAMES, revealStart: GROUP_2_START },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getPanelConnectionPoint(
  rect: DOMRect,
  overlayRect: DOMRect,
  anchor: Point
): { port: Point; outside: Point }[] {
  const left = rect.left - overlayRect.left;
  const right = rect.right - overlayRect.left;
  const top = rect.top - overlayRect.top;
  const bottom = rect.bottom - overlayRect.top;

  return [
    {
      port: { x: left, y: clamp(anchor.y, top + 16, bottom - 16) },
      outside: { x: left - CONNECTOR_GAP, y: clamp(anchor.y, top + 16, bottom - 16) },
    },
    {
      port: { x: right, y: clamp(anchor.y, top + 16, bottom - 16) },
      outside: { x: right + CONNECTOR_GAP, y: clamp(anchor.y, top + 16, bottom - 16) },
    },
    {
      port: { x: clamp(anchor.x, left + 16, right - 16), y: top },
      outside: { x: clamp(anchor.x, left + 16, right - 16), y: top - CONNECTOR_GAP },
    },
    {
      port: { x: clamp(anchor.x, left + 16, right - 16), y: bottom },
      outside: { x: clamp(anchor.x, left + 16, right - 16), y: bottom + CONNECTOR_GAP },
    },
  ];
}

function normalizePath(points: Point[]): Point[] {
  const cleaned: Point[] = [];

  for (const point of points) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.x === point.x && prev.y === point.y) continue;
    cleaned.push(point);
  }

  const flattened: Point[] = [];

  for (const point of cleaned) {
    const prev = flattened[flattened.length - 1];
    const prevPrev = flattened[flattened.length - 2];

    if (
      prev &&
      prevPrev &&
      ((prevPrev.x === prev.x && prev.x === point.x) ||
        (prevPrev.y === prev.y && prev.y === point.y))
    ) {
      flattened[flattened.length - 1] = point;
      continue;
    }

    flattened.push(point);
  }

  return flattened;
}

function getPathLength(points: Point[]): number {
  let length = 0;

  for (let i = 1; i < points.length; i += 1) {
    length += Math.abs(points[i].x - points[i - 1].x);
    length += Math.abs(points[i].y - points[i - 1].y);
  }

  return length;
}

function getPointAtLength(points: Point[], distance: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];

  let remaining = Math.max(0, distance);

  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1];
    const end = points[i];
    const segmentLength = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);

    if (segmentLength === 0) continue;
    if (remaining <= segmentLength) {
      const t = remaining / segmentLength;
      return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      };
    }

    remaining -= segmentLength;
  }

  return points[points.length - 1];
}

function buildPartialOrthogonalPath(
  points: Point[],
  startDistance: number,
  endDistance: number
): string {
  if (points.length === 0) return "";

  const totalLength = getPathLength(points);
  const clampedStart = clamp(startDistance, 0, totalLength);
  const clampedEnd = clamp(endDistance, clampedStart, totalLength);

  if (clampedEnd <= clampedStart) {
    const point = getPointAtLength(points, clampedStart);
    return `M ${point.x} ${point.y}`;
  }

  const pathPoints: Point[] = [getPointAtLength(points, clampedStart)];
  let traversed = 0;

  for (let i = 1; i < points.length; i += 1) {
    const segmentStart = points[i - 1];
    const segmentEnd = points[i];
    const segmentLength = Math.abs(segmentEnd.x - segmentStart.x) + Math.abs(segmentEnd.y - segmentStart.y);
    const nextTraversed = traversed + segmentLength;

    if (segmentLength > 0 && nextTraversed > clampedStart && nextTraversed < clampedEnd) {
      pathPoints.push(segmentEnd);
    }

    traversed = nextTraversed;
  }

  pathPoints.push(getPointAtLength(points, clampedEnd));
  return buildOrthogonalPath(normalizePath(pathPoints));
}

function buildOrthogonalPoints(
  anchor: Point,
  panelRect: DOMRect,
  overlayRect: DOMRect
): Point[] {
  const candidates = getPanelConnectionPoint(panelRect, overlayRect, anchor).flatMap(
    ({ port, outside }) => {
      const horizontalFirst = normalizePath([
        anchor,
        { x: outside.x, y: anchor.y },
        outside,
        port,
      ]);

      const verticalFirst = normalizePath([
        anchor,
        { x: anchor.x, y: outside.y },
        outside,
        port,
      ]);

      return [horizontalFirst, verticalFirst];
    }
  );

  const best = candidates.reduce((shortest, candidate) => {
    if (!shortest) return candidate;
    return getPathLength(candidate) < getPathLength(shortest) ? candidate : shortest;
  }, null as Point[] | null);

  return best ?? [];
}

function buildOrthogonalPath(points: Point[]): string {
  if (points.length === 0) return "";
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

function applyBlueprintStyle(mesh: Mesh): void {
  const geom = mesh.geometry;
  if (!geom) return;

  const mat = new MeshBasicMaterial({
    color: 0xfdf4df,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    depthTest: true,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  mesh.material = mat;

  const edges = new EdgesGeometry(geom, 15);
  const line = new LineSegments(
    edges,
    new LineBasicMaterial({ color: 0x2c1c12, depthTest: true })
  );

  line.renderOrder = 1;
  mesh.add(line);
}

function applyBlueprintToScene(scene: Scene): void {
  scene.traverse((child) => {
    if (!(child instanceof Mesh) || !child.geometry) return;
    applyBlueprintStyle(child);
  });
}

function getExplodeDirectionOverride(name: string): Vector3 {
  if (name === "Top") return new Vector3(0, 1, 0);
  if (name === "Bottom") return new Vector3(0, -1, 0);

  if (name === "Side_left" || name === "Side_right") {
    return new Vector3(-1, 0, 0);
  }

  if (name === "Front" || name.startsWith("FrontPanel")) {
    return new Vector3(1, 0, 0);
  }

  return getExplodeWorldDirection(name as never).clone();
}

function clampPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number | null): string {
  if (value == null) return "—";
  return `${value.toFixed(1)}%`;
}

function formatGigabytes(
  used: number | null | undefined,
  total: number | null | undefined
): string {
  const hasUsed = typeof used === "number" && Number.isFinite(used);
  const hasTotal = typeof total === "number" && Number.isFinite(total);

  if (hasUsed && hasTotal) {
    return `${used!.toFixed(1)} / ${total!.toFixed(1)} GB`;
  }

  if (hasTotal) {
    return `${total!.toFixed(1)} GB`;
  }

  if (hasUsed) {
    return `${used!.toFixed(1)} GB`;
  }

  return "—";
}

function formatUptime(totalSeconds: number | null | undefined): string {
  if (typeof totalSeconds !== "number" || !Number.isFinite(totalSeconds)) {
    return "—";
  }

  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatLastRefresh(iso: string | null | undefined): string {
  if (!iso) return "—";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatCpuTitle(model: string | null | undefined): string {
  if (!model || !model.trim()) return "CPU";

  const cleaned = model
    .replace(/\(R\)/g, "")
    .replace(/\(TM\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return `CPU • ${cleaned}`;
}

function formatGpuTitle(model: string | null | undefined): string {
  if (!model || !model.trim()) return "GPU";
  return `GPU • ${model.trim()}`;
}

function formatTemperature(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value.toFixed(0)} C`;
}

type PanelData = {
  title: string;
  primaryLabel: string;
  primaryValue: string;
  secondaryLabel: string;
  secondaryValue: string;
  percent: number | null;
};

function extractCpuTelemetry(metrics: MetricsResponse | null): PanelData {
  return {
    title: formatCpuTitle(metrics?.cpu?.model ?? null),
    primaryLabel: "Uptime",
    primaryValue: formatUptime(metrics?.uptime_seconds ?? null),
    secondaryLabel: "Last Refresh",
    secondaryValue: formatLastRefresh(metrics?.last_updated ?? null),
    percent: clampPercent(metrics?.cpu?.percent ?? null),
  };
}

function extractRamTelemetry(metrics: MetricsResponse | null): PanelData {
  return {
    title: "RAM",
    primaryLabel: "Capacity",
    primaryValue: formatGigabytes(
      metrics?.mem?.used_gb ?? null,
      metrics?.mem?.total_gb ?? null
    ),
    secondaryLabel: "Available",
    secondaryValue:
      typeof metrics?.mem?.available_gb === "number"
        ? `${metrics.mem.available_gb.toFixed(1)} GB`
        : "—",
    percent: clampPercent(metrics?.mem?.percent ?? null),
  };
}

function extractGpuTelemetry(metrics: MetricsResponse | null): PanelData {
  return {
    title: formatGpuTitle(metrics?.gpu?.model ?? null),
    primaryLabel: "Temperature",
    primaryValue: formatTemperature(metrics?.gpu?.temperature_c ?? null),
    secondaryLabel: "Memory",
    secondaryValue: formatGigabytes(
      metrics?.gpu?.used_gb ?? null,
      metrics?.gpu?.total_gb ?? null
    ),
    percent: clampPercent(metrics?.gpu?.percent ?? null),
  };
}

function TelemetryWindow({
  data,
  innerRef,
  shellRef,
  contentRef,
  position,
  onDragStart,
}: {
  data: PanelData;
  innerRef: RefObject<HTMLDivElement>;
  shellRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  position: PanelPosition;
  onDragStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      ref={innerRef}
      className={[
        "pointer-events-auto absolute z-20 w-[240px] overflow-hidden border",
        "border-[#4e3221] bg-[#f6ead1] text-[#3a2418]",
        "shadow-[4px_4px_0_rgba(78,50,33,0.18)]",
        "transition-[opacity,transform] duration-300 ease-out",
      ].join(" ")}
      style={{ left: position.x, top: position.y }}
    >
      <div
        ref={shellRef}
        className="origin-[var(--panel-origin-x,50%)_var(--panel-origin-y,50%)] transition-transform duration-300 ease-out"
      >
        <div
          className="cursor-grab border-b border-[#4e3221] bg-[#ead9b7] px-4 py-2 active:cursor-grabbing"
          onPointerDown={onDragStart}
        >
          <div className="flex items-center justify-start text-[10px] uppercase tracking-[0.22em] text-[#3a2418]">
            <span>{data.title}</span>
          </div>
        </div>

        <div
          ref={contentRef}
          className="px-4 py-4 text-[#3a2418] transition-[opacity,transform] duration-300 ease-out"
        >
          <div className="grid grid-cols-1 gap-2">
            <div className="border border-[#4e3221] bg-[#efe1c3] px-3 py-3">
              <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[#6b4a36]">
                {data.primaryLabel}
              </div>
              <div className="font-mono text-xl leading-none tracking-tight text-[#3a2418]">
                {data.primaryValue}
              </div>
            </div>

            <div className="border border-[#4e3221] bg-[#efe1c3] px-3 py-3">
              <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[#6b4a36]">
                {data.secondaryLabel}
              </div>
              <div className="font-mono text-sm leading-none tracking-tight text-[#3a2418]">
                {data.secondaryValue}
              </div>
            </div>
          </div>

          <div className="mt-4 text-[11px] uppercase tracking-[0.18em] text-[#6b4a36]">
            Resource Load
          </div>

          <div className="mt-1 font-mono text-3xl leading-none tracking-tight text-[#3a2418]">
            {formatPercent(data.percent)}
          </div>

          <div className="mt-3 flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-[#6b4a36]">
            <span>Occupancy</span>
            <span className="font-mono text-[#3a2418]">
              {formatPercent(data.percent)}
            </span>
          </div>

          <div className="mt-2 h-2 border border-[#4e3221] bg-[#e7d7b4] p-[2px]">
            <div
              className="h-full bg-[#6b4a36] transition-[width] duration-500"
              style={{ width: `${data.percent ?? 0}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ServerCaseBlueprint({
  metrics,
}: {
  metrics: MetricsResponse | null;
}) {
  const [bannerPreview, setBannerPreview] = useState({
    visible: false,
    x: 0,
    y: 0,
  });
  const bannerPreviewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasMountRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const cpuPanelRef = useRef<HTMLDivElement>(null);
  const ramPanelRef = useRef<HTMLDivElement>(null);
  const gpuPanelRef = useRef<HTMLDivElement>(null);
  const cpuShellRef = useRef<HTMLDivElement>(null);
  const ramShellRef = useRef<HTMLDivElement>(null);
  const gpuShellRef = useRef<HTMLDivElement>(null);
  const cpuContentRef = useRef<HTMLDivElement>(null);
  const ramContentRef = useRef<HTMLDivElement>(null);
  const gpuContentRef = useRef<HTMLDivElement>(null);
  const cpuPathRef = useRef<SVGPathElement>(null);
  const ramPathRef = useRef<SVGPathElement>(null);
  const gpuPathRef = useRef<SVGPathElement>(null);
  const scrollTrackRef = useRef<HTMLDivElement>(null);
  const scrollProgressFillRef = useRef<HTMLDivElement>(null);
  const scrollIndicatorRef = useRef<HTMLDivElement>(null);
  const scrollProgressLabelRef = useRef<HTMLSpanElement>(null);
  const zoomTrackRef = useRef<HTMLDivElement>(null);
  const zoomScaleFillRef = useRef<HTMLDivElement>(null);
  const zoomIndicatorRef = useRef<HTMLDivElement>(null);
  const zoomScaleLabelRef = useRef<HTMLSpanElement>(null);
  const currentProgressRef = useRef(0);
  const animationProgressRef = useRef(0);
  const setScrollProgressRef = useRef<(progress: number) => void>(() => {});
  const setZoomProgressRef = useRef<(progress: number) => void>(() => {});
  const dragStateRef = useRef<{
    panel: PanelKey;
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const hudDragStateRef = useRef<{
    control: "scroll" | "zoom";
    pointerId: number;
  } | null>(null);
  const didInitPanelPositionsRef = useRef(false);

  const cpuTelemetry = useMemo(() => extractCpuTelemetry(metrics), [metrics]);
  const ramTelemetry = useMemo(() => extractRamTelemetry(metrics), [metrics]);
  const gpuTelemetry = useMemo(() => extractGpuTelemetry(metrics), [metrics]);
  const [panelPositions, setPanelPositions] = useState<Record<PanelKey, PanelPosition>>({
    cpu: { x: PANEL_MARGIN, y: 96 },
    ram: { x: PANEL_MARGIN, y: 96 },
    gpu: { x: PANEL_MARGIN, y: 96 },
  });

  useEffect(() => {
    return () => {
      if (bannerPreviewTimeoutRef.current) {
        clearTimeout(bannerPreviewTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || !window.matchMedia("(pointer: coarse)").matches) return;

    const preventTouchScroll = (event: TouchEvent) => {
      event.preventDefault();
    };

    section.style.touchAction = "none";
    section.addEventListener("touchmove", preventTouchScroll, { passive: false });

    return () => {
      section.style.touchAction = "";
      section.removeEventListener("touchmove", preventTouchScroll);
    };
  }, []);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const syncPanelPositions = () => {
      const overlayRect = overlay.getBoundingClientRect();

      setPanelPositions((current) => {
        const cpuHeight = cpuPanelRef.current?.getBoundingClientRect().height ?? 280;
        const ramHeight = ramPanelRef.current?.getBoundingClientRect().height ?? 280;
        const gpuHeight = gpuPanelRef.current?.getBoundingClientRect().height ?? 280;

        const nextCpu = {
          x: clamp(current.cpu.x, PANEL_MARGIN, Math.max(PANEL_MARGIN, overlayRect.width - PANEL_WIDTH - PANEL_MARGIN)),
          y: clamp(current.cpu.y, PANEL_MARGIN, Math.max(PANEL_MARGIN, overlayRect.height - cpuHeight - PANEL_MARGIN)),
        };

        const desiredRamX = overlayRect.width - PANEL_WIDTH - PANEL_MARGIN;
        const nextRam = {
          x: didInitPanelPositionsRef.current
            ? clamp(
                current.ram.x,
                PANEL_MARGIN,
                Math.max(PANEL_MARGIN, overlayRect.width - PANEL_WIDTH - PANEL_MARGIN)
              )
            : Math.max(PANEL_MARGIN, desiredRamX),
          y: clamp(current.ram.y, PANEL_MARGIN, Math.max(PANEL_MARGIN, overlayRect.height - ramHeight - PANEL_MARGIN)),
        };

        const desiredGpuY = Math.max(
          PANEL_MARGIN,
          overlayRect.height - gpuHeight - PANEL_MARGIN
        );
        const nextGpu = {
          x: didInitPanelPositionsRef.current
            ? clamp(
                current.gpu.x,
                PANEL_MARGIN,
                Math.max(PANEL_MARGIN, overlayRect.width - PANEL_WIDTH - PANEL_MARGIN)
              )
            : Math.max(PANEL_MARGIN, desiredRamX),
          y: didInitPanelPositionsRef.current
            ? clamp(
                current.gpu.y,
                PANEL_MARGIN,
                Math.max(PANEL_MARGIN, overlayRect.height - gpuHeight - PANEL_MARGIN)
              )
            : desiredGpuY,
        };

        const nextCpuAdjusted = didInitPanelPositionsRef.current
          ? nextCpu
          : {
              x: PANEL_MARGIN,
              y: Math.max(PANEL_MARGIN, Math.min(96, overlayRect.height - cpuHeight - PANEL_MARGIN)),
            };

        didInitPanelPositionsRef.current = true;
        return { cpu: nextCpuAdjusted, ram: nextRam, gpu: nextGpu };
      });
    };

    syncPanelPositions();
    window.addEventListener("resize", syncPanelPositions);

    return () => {
      window.removeEventListener("resize", syncPanelPositions);
    };
  }, []);

  useEffect(() => {
    const movePanel = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      const overlay = overlayRef.current;
      if (!dragState || !overlay) return;

      const overlayRect = overlay.getBoundingClientRect();
      const panelRef =
        dragState.panel === "cpu"
          ? cpuPanelRef.current
          : dragState.panel === "ram"
            ? ramPanelRef.current
            : gpuPanelRef.current;
      const panelHeight = panelRef?.getBoundingClientRect().height ?? 280;

      const nextX = clamp(
        event.clientX - overlayRect.left - dragState.offsetX,
        PANEL_MARGIN,
        Math.max(PANEL_MARGIN, overlayRect.width - PANEL_WIDTH - PANEL_MARGIN)
      );
      const nextY = clamp(
        event.clientY - overlayRect.top - dragState.offsetY,
        PANEL_MARGIN,
        Math.max(PANEL_MARGIN, overlayRect.height - panelHeight - PANEL_MARGIN)
      );

      setPanelPositions((current) => ({
        ...current,
        [dragState.panel]: { x: nextX, y: nextY },
      }));
    };

    const stopDragging = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      dragStateRef.current = null;
    };

    window.addEventListener("pointermove", movePanel);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", movePanel);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, []);

  useEffect(() => {
    const updateHudDrag = (event: PointerEvent) => {
      const dragState = hudDragStateRef.current;
      if (!dragState) return;

      if (dragState.control === "scroll") {
        const track = scrollTrackRef.current;
        if (!track) return;

        const rect = track.getBoundingClientRect();
        const progress = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        setScrollProgressRef.current(progress);
        return;
      }

      const track = zoomTrackRef.current;
      if (!track) return;

      const rect = track.getBoundingClientRect();
      const progress = clamp((rect.bottom - event.clientY) / Math.max(1, rect.height), 0, 1);
      setZoomProgressRef.current(progress);
    };

    const stopHudDrag = (event: PointerEvent) => {
      const dragState = hudDragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      hudDragStateRef.current = null;
    };

    window.addEventListener("pointermove", updateHudDrag);
    window.addEventListener("pointerup", stopHudDrag);
    window.addEventListener("pointercancel", stopHudDrag);

    return () => {
      window.removeEventListener("pointermove", updateHudDrag);
      window.removeEventListener("pointerup", stopHudDrag);
      window.removeEventListener("pointercancel", stopHudDrag);
    };
  }, []);

  useEffect(() => {
    const container = canvasMountRef.current;
    const section = sectionRef.current;
    const overlay = overlayRef.current;
    if (!container || !section || !overlay) return;

    let targetProgress = 0;
    let currentProgress = 0;
    const lerpAmount = 0.05;

    const scene = new Scene();
    scene.background = new Color(0xfbf6ee);

    const camera = new PerspectiveCamera(45, 1, 0.01, 500);
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);

    Object.assign(renderer.domElement.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      zIndex: "0",
    });

    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableZoom = false;
    controls.enablePan = false;

    const tl = createTimeline({ autoplay: false });
    const scrollState = { p: 0 };
    tl.add(scrollState, { p: [0, 1], duration: 1000, ease: "linear" });

    const partsMap = new Map<string, Object3D>();
    const hoverMap = new Map<string, Object3D>();
    const dvdPartsMap = new Map<string, Object3D>();
    const originalScales = new Map<string, Vector3>();

    const baseWorld = new Map<string, Vector3>();
    const worldDir = new Map<string, Vector3>();
    const dvdBaseLocal = new Map<string, Vector3>();
    const hoverTarget = new Map<string, number>();
    const hoverCurrent = new Map<string, number>();
    const hoverBaseWorld = new Map<string, Vector3>();
    const telemetryAnchorWorld = new Map<PanelKey, Vector3>();
    const gpuFanBaseRotation = new Map<string, number>();

    let maxDistance = 0.45;
    let rootGroup: Group | null = null;
    let disposed = false;
    let raf = 0;

    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

    const getWindowForPart = (name: string): [number, number] => {
      if (name === "FrontPanelDVD" || name === "FrontPanelDVDDrive") {
        return [GROUP_1_START, GROUP_1_END];
      }

      if (
        name === "Back" ||
        (name.startsWith("Front") &&
          name !== "FrontPanelDVD" &&
          name !== "FrontPanelDVDDrive")
      ) {
        return [GROUP_2_START, GROUP_2_END];
      }

      if (name === "Side_right") {
        return [GROUP_3_START, GROUP_3_END];
      }

      if (name === "Side_left") {
        return [GROUP_4_START, GROUP_4_END];
      }

      if (name === "BackPower") {
        return [GROUP_5_START, GROUP_5_END];
      }

      if (name === "Top" || name === "Bottom") {
        return [GROUP_6_START, GROUP_6_END];
      }

      return [GROUP_2_START, GROUP_2_END];
    };

    const getPhaseProgress = (progress: number, start: number, end: number) => {
      if (progress <= start) return 0;
      if (progress >= end) return 1;
      return clamp01((progress - start) / (end - start));
    };

    const getAverageWorldPosition = (names: string[]) => {
      const points: Vector3[] = [];

      for (const name of names) {
        const obj = hoverMap.get(name) ?? rootGroup?.getObjectByName(name);
        if (!obj) continue;

        const wp = new Vector3();
        obj.getWorldPosition(wp);
        points.push(wp);
      }

      if (points.length === 0) return null;

      const avg = new Vector3();
      for (const p of points) avg.add(p);
      avg.divideScalar(points.length);
      return avg;
    };

    const setConnectorPath = (
      path: SVGPathElement | null,
      panel: HTMLDivElement | null,
      shell: HTMLDivElement | null,
      content: HTMLDivElement | null,
      anchor: ScreenAnchor | null,
      revealProgress: number
    ) => {
      if (!path || !panel || !anchor) return;

      const overlayRect = overlay.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const points = buildOrthogonalPoints(anchor, panelRect, overlayRect);
      const fullPath = buildOrthogonalPath(points);
      const endPoint = points[points.length - 1];
      const lineProgress = clamp(revealProgress / 0.55, 0, 1);
      const shellProgress = clamp((revealProgress - 0.55) / 0.25, 0, 1);
      const contentProgress = clamp((revealProgress - 0.8) / 0.2, 0, 1);
      const totalLength = getPathLength(points);
      const midpoint = totalLength * 0.5;
      const visibleHalf = totalLength * 0.5 * lineProgress;
      const partialPath =
        points.length > 1
          ? buildPartialOrthogonalPath(
              points,
              midpoint - visibleHalf,
              midpoint + visibleHalf
            )
          : fullPath;

      path.setAttribute("d", partialPath);
      path.style.strokeDasharray = "";
      path.style.strokeDashoffset = "";

      path.style.opacity = revealProgress > 0 && anchor.visible ? "1" : "0";

      const isVisible = revealProgress > 0;
      panel.style.opacity = `${clamp(revealProgress * 1.25, 0, 1)}`;
      panel.style.visibility = isVisible ? "visible" : "hidden";
      panel.style.pointerEvents = revealProgress >= 0.99 ? "auto" : "none";

      if (shell) {
        const originX = endPoint
          ? `${clamp(((endPoint.x - (panelRect.left - overlayRect.left)) / Math.max(1, panelRect.width)) * 100, 0, 100)}%`
          : "50%";
        const originY = endPoint
          ? `${clamp(((endPoint.y - (panelRect.top - overlayRect.top)) / Math.max(1, panelRect.height)) * 100, 0, 100)}%`
          : "50%";

        shell.style.setProperty("--panel-origin-x", originX);
        shell.style.setProperty("--panel-origin-y", originY);
        shell.style.transform = `scale(${0.92 + shellProgress * 0.08})`;
        shell.style.opacity = `${shellProgress}`;
      }

      if (content) {
        content.style.opacity = `${contentProgress}`;
        content.style.transform = `translateY(${(1 - contentProgress) * 8}px)`;
      }
    };

    const updateHud = () => {
      const scrollFill = scrollProgressFillRef.current;
      const scrollIndicator = scrollIndicatorRef.current;
      const scrollLabel = scrollProgressLabelRef.current;
      const zoomFill = zoomScaleFillRef.current;
      const zoomIndicator = zoomIndicatorRef.current;
      const zoomLabel = zoomScaleLabelRef.current;

      if (scrollFill) {
        scrollFill.style.width = `${currentProgressRef.current * 100}%`;
      }

      if (scrollIndicator) {
        scrollIndicator.style.left = `${currentProgressRef.current * 100}%`;
      }

      if (scrollLabel) {
        scrollLabel.textContent = `${Math.round(currentProgressRef.current * 100)}%`;
      }

      const zoomRange = Math.max(0.0001, controls.maxDistance - controls.minDistance);
      const zoomDistance = camera.position.distanceTo(controls.target);
      const zoomProgress = clamp01((controls.maxDistance - zoomDistance) / zoomRange);

      if (zoomFill) {
        zoomFill.style.width = `${zoomProgress * 100}%`;
      }

      if (zoomIndicator) {
        zoomIndicator.style.left = `${100 - zoomProgress * 100}%`;
      }

      if (zoomLabel) {
        zoomLabel.textContent = `${Math.round(zoomProgress * 100)}%`
          .split("")
          .join("\n");
      }
    };

    const updateTelemetryOverlay = () => {
      const panelRefs: Record<PanelKey, HTMLDivElement | null> = {
        cpu: cpuPanelRef.current,
        ram: ramPanelRef.current,
        gpu: gpuPanelRef.current,
      };
      const shellRefs: Record<PanelKey, HTMLDivElement | null> = {
        cpu: cpuShellRef.current,
        ram: ramShellRef.current,
        gpu: gpuShellRef.current,
      };
      const contentRefs: Record<PanelKey, HTMLDivElement | null> = {
        cpu: cpuContentRef.current,
        ram: ramContentRef.current,
        gpu: gpuContentRef.current,
      };
      const pathRefs: Record<PanelKey, SVGPathElement | null> = {
        cpu: cpuPathRef.current,
        ram: ramPathRef.current,
        gpu: gpuPathRef.current,
      };

      for (const panelConfig of PANEL_CONFIGS) {
        const anchorWorld = telemetryAnchorWorld.get(panelConfig.key);
        const anchor: ScreenAnchor | null = anchorWorld
          ? projectWorldToScreen(
              anchorWorld,
              camera,
              renderer.domElement.width,
              renderer.domElement.height
            )
          : null;
        const revealProgress = anchor?.visible
          ? getPhaseProgress(
              animationProgressRef.current,
              panelConfig.revealStart,
              panelConfig.revealStart + PANEL_REVEAL_DURATION
            )
          : 0;

        setConnectorPath(
          pathRefs[panelConfig.key],
          panelRefs[panelConfig.key],
          shellRefs[panelConfig.key],
          contentRefs[panelConfig.key],
          anchor,
          revealProgress
        );
      }
    };

    const updateCasePositions = (progress: number) => {
      if (!rootGroup) return;

      for (const [name, obj] of partsMap) {
        const bw = baseWorld.get(name);
        const wd = worldDir.get(name);
        if (!bw || !wd || !obj.parent) continue;

        const [start, end] = getWindowForPart(name);
        const phase = getPhaseProgress(progress, start, end);

        const targetWorld = bw.clone().addScaledVector(wd, phase * maxDistance);

        const shrinkStart = end;
        const shrinkEnd = Math.min(0.995, shrinkStart + 0.06);
        const shrinkP = getPhaseProgress(progress, shrinkStart, shrinkEnd);
        const shrinkScale = Math.max(1 - shrinkP, MIN_VISIBLE_SCALE);
        const shouldHide = shrinkP >= 0.999;

        obj.scale.setScalar(shrinkScale);

        const parentLocalPos = targetWorld.clone();
        obj.parent.worldToLocal(parentLocalPos);
        obj.position.copy(parentLocalPos);
        obj.visible = !shouldHide;
      }

      const dvdDrive = dvdPartsMap.get("FrontPanelDVDDrive");
      const dvdTray = dvdPartsMap.get("FrontPanelDVD");

      if (dvdDrive && dvdTray) {
        const driveBase = dvdBaseLocal.get("FrontPanelDVDDrive");
        const trayBase = dvdBaseLocal.get("FrontPanelDVD");

        if (driveBase && trayBase) {
          const preP = getPhaseProgress(progress, 0, DVD_PREROLL_END);
          const explodeP = getPhaseProgress(progress, GROUP_1_START, GROUP_1_END);

          const getDvdPos = (base: Vector3, isTray: boolean) => {
            const pos = base.clone();

            pos.addScaledVector(DVD_FORWARD_AXIS, DVD_PREROLL_DIST * preP);

            if (isTray && preP > 0.5) {
              const trayLift = (preP - 0.5) / 0.5;
              pos.addScaledVector(DVD_TRAY_AXIS, DVD_TRAY_DIST * trayLift);
              pos.addScaledVector(DVD_FORWARD_AXIS, DVD_PREROLL_DIST * trayLift);
            }

            pos.addScaledVector(DVD_FORWARD_AXIS, explodeP * maxDistance);

            return pos;
          };

          dvdDrive.position.copy(getDvdPos(driveBase, false));
          dvdTray.position.copy(getDvdPos(trayBase, true));

          const dvdShrinkStart = GROUP_1_END;
          const dvdShrinkEnd = Math.min(0.995, dvdShrinkStart + 0.06);
          const dvdShrinkP = getPhaseProgress(progress, dvdShrinkStart, dvdShrinkEnd);
          const dvdShrinkScale = Math.max(1 - dvdShrinkP, MIN_VISIBLE_SCALE);
          const shouldHideDvd = dvdShrinkP >= 0.999;

          dvdDrive.scale.setScalar(dvdShrinkScale);
          dvdTray.scale.setScalar(dvdShrinkScale);

          dvdDrive.visible = !shouldHideDvd;
          dvdTray.visible = !shouldHideDvd;
        }
      }

      for (const [name, obj] of hoverMap) {
        const base = hoverBaseWorld.get(name);
        const origScale = originalScales.get(name) || new Vector3(1, 1, 1);
        if (!base || !obj.parent) continue;

        const curOffset = hoverCurrent.get(name) ?? 0;
        const targetWorld = base.clone().addScaledVector(WORLD_UP, curOffset);
        const localPos = targetWorld.clone();
        obj.parent.worldToLocal(localPos);
        obj.position.copy(localPos);

        obj.scale.copy(origScale);
        obj.visible = true;
      }

      const spinTime = performance.now() * 0.001;
      for (const fanName of GPU_FAN_NAMES) {
        const fan = hoverMap.get(fanName) ?? rootGroup.getObjectByName(fanName);
        if (!fan) continue;

        const baseRotation = gpuFanBaseRotation.get(fanName) ?? 0;
        fan.rotation.y = baseRotation + spinTime * GPU_FAN_SPIN_SPEED;
      }
    };

    const getSectionScrollProgress = (): number => {
      const rect = section.getBoundingClientRect();
      const vh = window.innerHeight;
      const totalScrollable = Math.max(1, rect.height - vh);
      const scrolled = Math.min(totalScrollable, Math.max(0, -rect.top));
      return clamp01(scrolled / totalScrollable);
    };

    const setScrollProgress = (progress: number) => {
      const clamped = clamp01(progress);
      const rect = section.getBoundingClientRect();
      const absoluteTop = window.scrollY + rect.top;
      const totalScrollable = Math.max(1, rect.height - window.innerHeight);

      targetProgress = clamped;
      window.scrollTo({
        top: absoluteTop + clamped * totalScrollable,
        behavior: "auto",
      });
    };

    const setZoomProgress = (progress: number) => {
      const clamped = clamp01(progress);
      const desiredDistance =
        controls.maxDistance - clamped * (controls.maxDistance - controls.minDistance);
      const direction = camera.position.clone().sub(controls.target).normalize();

      camera.position.copy(
        controls.target.clone().addScaledVector(direction, desiredDistance)
      );
      camera.updateProjectionMatrix();
    };

    setScrollProgressRef.current = setScrollProgress;
    setZoomProgressRef.current = setZoomProgress;

    const onScroll = () => {
      targetProgress = getSectionScrollProgress();
    };

    const loop = () => {
      if (disposed) return;

      currentProgress += (targetProgress - currentProgress) * lerpAmount;

      if (Math.abs(targetProgress - currentProgress) < 0.0005) {
        currentProgress = targetProgress;
      }

      currentProgressRef.current = currentProgress;
      animationProgressRef.current = currentProgress * FINAL_ANIMATION_PROGRESS;

      tl.seek(animationProgressRef.current * tl.duration);
      updateCasePositions(animationProgressRef.current);

      for (const [name] of hoverMap) {
        const target = hoverTarget.get(name) ?? 0;
        const current = hoverCurrent.get(name) ?? 0;
        hoverCurrent.set(name, current + (target - current) * 0.08);
      }

      controls.update();
      updateTelemetryOverlay();
      updateHud();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!rootGroup || hoverMap.size === 0) return;

      const rect = renderer.domElement.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = ((e.clientY - rect.top) / rect.height) * -2 + 1;
      let gpuHovered = false;

      for (const [name, obj] of hoverMap) {
        const wp = new Vector3();
        obj.getWorldPosition(wp);

        const { x: sx, y: sy } = projectWorldToScreen(
          wp,
          camera,
          renderer.domElement.width,
          renderer.domElement.height
        );

        const ndcX = (sx / renderer.domElement.width) * 2 - 1;
        const ndcY = (sy / renderer.domElement.height) * -2 + 1;
        const hovered = Math.hypot(nx - ndcX, ny - ndcY) < 0.12;

        if (GPU_PART_NAMES.includes(name)) {
          gpuHovered ||= hovered;
          continue;
        }

        hoverTarget.set(name, hovered ? HOVER_PARTS[name] ?? 0.05 : 0);
      }

      for (const gpuName of GPU_PART_NAMES) {
        if (!hoverMap.has(gpuName)) continue;
        hoverTarget.set(gpuName, gpuHovered ? HOVER_PARTS[gpuName] ?? 0.05 : 0);
      }
    };

    const loader = new GLTFLoader();

    loader.load(MODEL_URL, (gltf) => {
      if (disposed) return;

      rootGroup = gltf.scene;
      scene.add(rootGroup);
      applyBlueprintToScene(scene);

      const box = new Box3().setFromObject(rootGroup);
      const center = box.getCenter(new Vector3());
      const size = box.getSize(new Vector3());

      rootGroup.position.sub(center);
      rootGroup.updateMatrixWorld(true);

      const maxDim = Math.max(size.x, size.y, size.z, 0.001);
      const dist = maxDim * 1.8;

      const motherboardCenter =
        getAverageWorldPosition(MOTHERBOARD_PART_NAMES) ?? new Vector3(0, 0, 0);

      controls.target.copy(motherboardCenter);
      controls.minDistance = dist * 0.55;
      controls.maxDistance = dist * 1.2;
      camera.position.set(
        motherboardCenter.x + dist * 0.55,
        motherboardCenter.y + dist * 0.35,
        motherboardCenter.z + dist * 0.65
      );
      camera.lookAt(motherboardCenter);

      const explodeScale = Math.max(
        0.25,
        Number(process.env.NEXT_PUBLIC_CASE_EXPLODE_SCALE ?? 1)
      );

      maxDistance = maxDim * STOP_DISTANCE_MULT * explodeScale;

      const collected = collectCaseParts(rootGroup);
      for (const name of CASE_OBJECT_NAMES) {
        const obj = collected[name as keyof typeof collected];
        if (obj) partsMap.set(name, obj);
      }

      rootGroup.traverse((child) => {
        const n = child.name;
        if (!n) return;

        originalScales.set(n, child.scale.clone());

        if (n in HOVER_PARTS) {
          hoverMap.set(n, child);
          partsMap.delete(n);
          return;
        }

        if (n === "FrontPanelDVDDrive" || n === "FrontPanelDVD") {
          partsMap.delete(n);
          dvdPartsMap.set(n, child);
          return;
        }

        if (n === "BackPower") {
          partsMap.set(n, child);
          return;
        }

        if (n.startsWith("Front") && !n.includes("DVD")) {
          partsMap.set(n, child);
        }
      });

      rootGroup.updateMatrixWorld(true);

      for (const [name, obj] of [...partsMap]) {
        if (!obj.parent) continue;

        const parent = obj.parent;
        const centerWorld = new Box3().setFromObject(obj).getCenter(new Vector3());
        const centerParentLocal = parent.worldToLocal(centerWorld.clone());
        const pivot = new Group();

        pivot.name = `${name}__explodePivot`;
        pivot.position.copy(centerParentLocal);

        parent.add(pivot);
        pivot.updateMatrixWorld(true);
        pivot.attach(obj);
        partsMap.set(name, pivot);
      }

      for (const [name, obj] of [...dvdPartsMap]) {
        if (!obj.parent) continue;

        const parent = obj.parent;
        const centerWorld = new Box3().setFromObject(obj).getCenter(new Vector3());
        const centerParentLocal = parent.worldToLocal(centerWorld.clone());
        const pivot = new Group();

        pivot.name = `${name}__dvdPivot`;
        pivot.position.copy(centerParentLocal);

        parent.add(pivot);
        pivot.updateMatrixWorld(true);
        pivot.attach(obj);

        dvdPartsMap.set(name, pivot);
        dvdBaseLocal.set(name, pivot.position.clone());
      }

      rootGroup.updateMatrixWorld(true);

      for (const [name, obj] of partsMap) {
        const bw = new Vector3();
        obj.getWorldPosition(bw);
        baseWorld.set(name, bw);
        worldDir.set(name, getExplodeDirectionOverride(name));
      }

      for (const [name, obj] of hoverMap) {
        const wp = new Vector3();
        obj.getWorldPosition(wp);
        hoverBaseWorld.set(name, wp.clone());
        hoverTarget.set(name, 0);
        hoverCurrent.set(name, 0);
      }

      for (const fanName of GPU_FAN_NAMES) {
        const fan = hoverMap.get(fanName) ?? rootGroup.getObjectByName(fanName);
        if (!fan) continue;
        gpuFanBaseRotation.set(fanName, fan.rotation.y);
      }

      for (const panelConfig of PANEL_CONFIGS) {
        const start = getAverageWorldPosition(panelConfig.partNames);
        if (start) telemetryAnchorWorld.set(panelConfig.key, start.clone());
      }

      onScroll();
      loop();
      window.dispatchEvent(new Event("resize"));
    });

    const resize = () => {
      renderer.setSize(container.clientWidth, container.clientHeight);
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      updateTelemetryOverlay();
      updateHud();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", resize);
    renderer.domElement.addEventListener("mousemove", onMouseMove);
    renderer.domElement.addEventListener("mouseleave", () => {
      for (const [name] of hoverMap) {
        hoverTarget.set(name, 0);
      }
    });

    return () => {
      disposed = true;
      setScrollProgressRef.current = () => {};
      setZoomProgressRef.current = () => {};
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", resize);
      renderer.domElement.removeEventListener("mousemove", onMouseMove);
      controls.dispose();
      renderer.dispose();
      scene.clear();

      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  const startPanelDrag =
    (panel: PanelKey) => (event: ReactPointerEvent<HTMLDivElement>) => {
      const overlay = overlayRef.current;
      const panelElement =
        panel === "cpu"
          ? cpuPanelRef.current
          : panel === "ram"
            ? ramPanelRef.current
            : gpuPanelRef.current;
      if (!overlay || !panelElement) return;

      const panelRect = panelElement.getBoundingClientRect();
      dragStateRef.current = {
        panel,
        pointerId: event.pointerId,
        offsetX: event.clientX - panelRect.left,
        offsetY: event.clientY - panelRect.top,
      };

      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    };

  const startHudDrag =
    (control: "scroll" | "zoom") => (event: ReactPointerEvent<HTMLDivElement>) => {
      hudDragStateRef.current = {
        control,
        pointerId: event.pointerId,
      };

      if (control === "scroll") {
        const track = scrollTrackRef.current;
        if (track) {
          const rect = track.getBoundingClientRect();
          const progress = clamp(
            (event.clientX - rect.left) / Math.max(1, rect.width),
            0,
            1
          );
          setScrollProgressRef.current(progress);
        }
      } else {
        const track = zoomTrackRef.current;
        if (track) {
          const rect = track.getBoundingClientRect();
          const progress = clamp(
            (rect.bottom - event.clientY) / Math.max(1, rect.height),
            0,
            1
          );
          setZoomProgressRef.current(progress);
        }
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    };

  const showBannerPreview = (event: ReactPointerEvent<HTMLDivElement>) => {
    setBannerPreview({
      visible: true,
      x: event.clientX + 18,
      y: event.clientY + 18,
    });
  };

  const moveBannerPreview = (event: ReactPointerEvent<HTMLDivElement>) => {
    setBannerPreview((current) =>
      current.visible
        ? {
            visible: true,
            x: event.clientX + 18,
            y: event.clientY + 18,
          }
        : current
    );
  };

  const hideBannerPreview = () => {
    setBannerPreview((current) => ({ ...current, visible: false }));
  };

  const tapBannerPreview = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!window.matchMedia("(pointer: coarse)").matches) return;

    if (bannerPreviewTimeoutRef.current) {
      clearTimeout(bannerPreviewTimeoutRef.current);
    }

    setBannerPreview({
      visible: true,
      x: event.clientX + 18,
      y: event.clientY - 120,
    });

    bannerPreviewTimeoutRef.current = setTimeout(() => {
      setBannerPreview((current) => ({ ...current, visible: false }));
      bannerPreviewTimeoutRef.current = null;
    }, 1400);
  };

  return (
    <section ref={sectionRef} className="relative w-full min-h-[270vh]">
      <div className="sticky top-0 z-0 flex min-h-screen w-full flex-col overflow-hidden">
        <div className="relative border-t border-brownBorder/70 bg-creamBg px-4 py-3 text-center text-xs uppercase tracking-wider text-brownMuted">
          <a href="https://evan-huang.dev" className="hover:underline">
            Evan
          </a>
          {"'s Server | "}
          <span
            className="cursor-pointer"
            onPointerEnter={showBannerPreview}
            onPointerMove={moveBannerPreview}
            onPointerLeave={hideBannerPreview}
            onPointerDown={tapBannerPreview}
          >
            pls dont hack me pls I need this
          </span>
        </div>

        <div
          className="pointer-events-none fixed left-0 top-0 z-40 transition-opacity duration-150"
          style={{
            opacity: bannerPreview.visible ? 1 : 0,
            transform: `translate3d(${bannerPreview.x}px, ${bannerPreview.y}px, 0)`,
          }}
        >
          <div className="border border-[#4e3221] bg-[#f6ead1] p-2 shadow-[4px_4px_0_rgba(78,50,33,0.18)]">
            <img
              src="/images/speed.png"
              alt="speed reaction"
              className="block h-auto w-40 border border-[#4e3221] object-cover"
            />
          </div>
        </div>

        <div className="relative flex-1 w-full">
          <div ref={canvasMountRef} className="absolute inset-0" />

          <div
            ref={overlayRef}
            className="pointer-events-none absolute inset-0 z-10"
          >
            <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
              <path
                ref={cpuPathRef}
                fill="none"
                stroke="#3a2418"
                strokeWidth="2"
                opacity="0"
              />
              <path
                ref={ramPathRef}
                fill="none"
                stroke="#3a2418"
                strokeWidth="2"
                opacity="0"
              />
              <path
                ref={gpuPathRef}
                fill="none"
                stroke="#3a2418"
                strokeWidth="2"
                opacity="0"
              />
            </svg>

            <div
              className="pointer-events-none absolute left-6 z-20 flex items-end gap-4 text-[#3a2418]"
              style={{ bottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
            >
              <div className="relative h-[220px] w-[52px]">
                <div className="pointer-events-none absolute left-1/2 top-1/2 w-[220px] -translate-x-1/2 -translate-y-1/2 rotate-90">
                  <div className="min-w-[220px] border border-[#4e3221] bg-[#f6ead1] px-3 py-2 shadow-[4px_4px_0_rgba(78,50,33,0.18)]">
                    <div className="mb-2 flex items-center justify-between text-[8px] uppercase tracking-[0.24em] text-[#6b4a36]">
                      <span
                        ref={zoomScaleLabelRef}
                        className="font-mono tracking-normal text-[#3a2418]"
                      >
                        0%
                      </span>
                      <span>Zoom</span>
                    </div>

                    <div className="h-4 border border-[#4e3221] bg-[#efe1c3] p-[3px]">
                      <div
                        ref={zoomTrackRef}
                        className="pointer-events-auto relative h-full cursor-pointer overflow-visible"
                        onPointerDown={startHudDrag("zoom")}
                      >
                        <div
                          ref={zoomScaleFillRef}
                          className="ml-auto h-full bg-[#6b4a36] transition-[width] duration-150"
                          style={{ width: "0%" }}
                        />
                        <div
                          ref={zoomIndicatorRef}
                          className="absolute top-1/2 h-[calc(100%+12px)] w-[3px] -translate-x-1/2 -translate-y-1/2 bg-[#ead9b7] shadow-[0_0_0_1px_#4e3221] transition-[left] duration-150"
                          style={{ left: "0%" }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="min-w-[220px] border border-[#4e3221] bg-[#f6ead1] px-3 py-2 shadow-[4px_4px_0_rgba(78,50,33,0.18)]">
                <div className="mb-2 flex items-center justify-between text-[8px] uppercase tracking-[0.24em] text-[#6b4a36]">
                  <span>Scroll</span>
                  <span ref={scrollProgressLabelRef} className="font-mono text-[#3a2418]">
                    0%
                  </span>
                </div>

                <div className="h-4 border border-[#4e3221] bg-[#efe1c3] p-[3px]">
                  <div
                    ref={scrollTrackRef}
                    className="pointer-events-auto relative h-full cursor-pointer overflow-visible"
                    onPointerDown={startHudDrag("scroll")}
                  >
                    <div
                      ref={scrollProgressFillRef}
                      className="h-full bg-[#6b4a36] transition-[width] duration-150"
                      style={{ width: "0%" }}
                    />
                    <div
                      ref={scrollIndicatorRef}
                      className="absolute top-1/2 h-[calc(100%+12px)] w-[3px] -translate-x-1/2 -translate-y-1/2 bg-[#ead9b7] shadow-[0_0_0_1px_#4e3221] transition-[left] duration-150"
                      style={{ left: "0%" }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <TelemetryWindow
              data={cpuTelemetry}
              innerRef={cpuPanelRef}
              shellRef={cpuShellRef}
              contentRef={cpuContentRef}
              position={panelPositions.cpu}
              onDragStart={startPanelDrag("cpu")}
            />

            <TelemetryWindow
              data={ramTelemetry}
              innerRef={ramPanelRef}
              shellRef={ramShellRef}
              contentRef={ramContentRef}
              position={panelPositions.ram}
              onDragStart={startPanelDrag("ram")}
            />

            <TelemetryWindow
              data={gpuTelemetry}
              innerRef={gpuPanelRef}
              shellRef={gpuShellRef}
              contentRef={gpuContentRef}
              position={panelPositions.gpu}
              onDragStart={startPanelDrag("gpu")}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
