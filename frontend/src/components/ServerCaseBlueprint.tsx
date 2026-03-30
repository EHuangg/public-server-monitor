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
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
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

const BLUEPRINT_BASE_COLOR = new Color(0xf6ead1);
const BLUEPRINT_HIGHLIGHT_HEX = "#d9e8f7";
const BLUEPRINT_ALERT_HIGHLIGHT_HEX = "#efb7b7";
const BLUEPRINT_HIGHLIGHT_COLOR = new Color(BLUEPRINT_HIGHLIGHT_HEX);
const BLUEPRINT_ALERT_HIGHLIGHT_COLOR = new Color(BLUEPRINT_ALERT_HIGHLIGHT_HEX);

function isSystemDown(metrics: MetricsResponse | null): boolean {
  const health = metrics?.system_health?.trim().toLowerCase() ?? "";
  return health.includes("down") || health.includes("offline");
}

function getBlueprintHighlightHex(metrics: MetricsResponse | null): string {
  return isSystemDown(metrics)
    ? BLUEPRINT_ALERT_HIGHLIGHT_HEX
    : BLUEPRINT_HIGHLIGHT_HEX;
}

function getBlueprintHighlightColor(metrics: MetricsResponse | null): Color {
  return isSystemDown(metrics)
    ? BLUEPRINT_ALERT_HIGHLIGHT_COLOR.clone()
    : BLUEPRINT_HIGHLIGHT_COLOR.clone();
}

function normalizeSceneName(name: string): string {
  return name.replace(/[._\s-]/g, "").toLowerCase();
}

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
  CPUFan: 0.05,
  CPUFan001: 0.05,
  CPUHeatSink: 0.03,
  "CPU.Fan": 0.05,
  "CPU.Fan.001": 0.05,
  "CPU.HeatSink": 0.03,
  GPUBase: 0.035,
  GPUFan: 0.03,
  HDD: 0.035,
  SSD: 0.03,
  CaseFan: 0.03,
  CaseFan001: 0.03,
};

const HOVER_DIRECTIONS: Record<string, Vector3> = {
  HDD: new Vector3(0, 0, 1),
  SSD: new Vector3(0, 0, 1),
  GPUBase: new Vector3(0, 0, 1),
  GPUFan: new Vector3(0, 0, 1),
  CPUFan: new Vector3(0, 0, 1),
  CPUFan001: new Vector3(0, 0, 1),
  CPUHeatSink: new Vector3(0, 0, 1),
  "CPU.Fan": new Vector3(0, 0, 1),
  "CPU.Fan.001": new Vector3(0, 0, 1),
  "CPU.HeatSink": new Vector3(0, 0, 1),
  CaseFan: new Vector3(0, 0, 1),
  CaseFan001: new Vector3(0, 0, 1),
};

const RAM_PART_NAMES = ["RAM", "RAM001", "RAM002", "RAM003"];
const CPU_CORE_PART_NAMES = ["CPU", "CPU001"];
const CPU_FAN_HOVER_PART_NAMES = [
  "CPUFan",
  "CPUFan001",
  "CPU.Fan",
  "CPU.Fan.001",
];
const CPU_HEATSINK_PART_NAMES = ["CPUHeatSink", "CPU.HeatSink"];
const CPU_COOLER_HOVER_PART_NAMES = [
  ...CPU_FAN_HOVER_PART_NAMES,
  ...CPU_HEATSINK_PART_NAMES,
];
const CPU_PART_NAMES = [
  ...CPU_CORE_PART_NAMES,
  ...CPU_FAN_HOVER_PART_NAMES,
  ...CPU_HEATSINK_PART_NAMES,
];
const MOTHERBOARD_PART_NAMES = ["MotherBoard"];
const GPU_PART_NAMES = ["GPUBase", "GPUFan"];
const HDD_PART_NAMES = ["HDD"];
const SSD_PART_NAMES = ["SSD"];
const CASE_FAN_A_PART_NAMES = ["CaseFan", "CaseFan001"];
const CASE_FAN_B_PART_NAMES = [...CPU_COOLER_HOVER_PART_NAMES];
const CASE_FAN_HOVER_PART_NAMES = ["CaseFan", "CaseFan001"];
const GPU_FAN_SPIN_SPEED = 8;
const RPM_TO_RAD_PER_SEC = (Math.PI * 2) / 60;
const FLAT_LAYOUT_GROUPS = [
  {
    key: "gpu",
    anchorName: "Anchor.GPU",
    partNames: GPU_PART_NAMES,
  },
  {
    key: "ssd",
    anchorName: "Anchor.SSD",
    partNames: ["SSD"],
  },
  {
    key: "hdd",
    anchorName: "Anchor.HDD",
    partNames: ["HDD"],
  },
  {
    key: "caseFan",
    anchorName: "Anchor.Case.Fan",
    partNames: CASE_FAN_HOVER_PART_NAMES,
  },
  {
    key: "cpuCooler",
    anchorName: "Anchor.CPU.Fan",
    partNames: CPU_COOLER_HOVER_PART_NAMES,
  },
] as const;
const FLAT_LAYOUT_GROUPS_BY_NORMALIZED_ANCHOR = new Map(
  FLAT_LAYOUT_GROUPS.map((group) => [normalizeSceneName(group.anchorName), group] as const)
);

function getSpinAxisVector(axis: "x" | "y" | "z"): Vector3 {
  if (axis === "x") return new Vector3(1, 0, 0);
  if (axis === "y") return new Vector3(0, 1, 0);
  return new Vector3(0, 0, 1);
}

const SPINNING_FAN_CONFIGS = [
  { names: ["GPUFan"], axis: "y" as const, speed: GPU_FAN_SPIN_SPEED },
  {
    names: ["CaseFan"],
    axis: "x" as const,
    speed: 0,
    metricKind: "case" as const,
  },
  {
    names: ["CPUFan", "CPU.Fan"],
    axis: "z" as const,
    speed: 0,
    metricKind: "cpu" as const,
  },
];

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
const FLAT_LAYOUT_START = GROUP_6_START + 0.035;
const FLAT_LAYOUT_END = Math.min(0.995, FLAT_LAYOUT_START + 0.16);

const MIN_VISIBLE_SCALE = 0.0001;
const PANEL_WIDTH = 240;
const PANEL_MARGIN = 24;
const CONNECTOR_GAP = 20;
const PANEL_REVEAL_DURATION = 0.1;

type PanelKey =
  | "cpu"
  | "ram"
  | "gpu"
  | "hdd"
  | "ssd"
  | "caseFanA"
  | "caseFanB";
type Point = { x: number; y: number };
type PanelPosition = { x: number; y: number };
type ScreenAnchor = { x: number; y: number; visible: boolean };
type PanelConfig = {
  key: PanelKey;
  partNames: string[];
  revealStart: number;
};

const PANEL_CONFIGS: PanelConfig[] = [
  { key: "cpu", partNames: CPU_CORE_PART_NAMES, revealStart: GROUP_2_START },
  { key: "ram", partNames: RAM_PART_NAMES, revealStart: GROUP_2_START },
  { key: "gpu", partNames: GPU_PART_NAMES, revealStart: GROUP_2_START },
  { key: "hdd", partNames: HDD_PART_NAMES, revealStart: GROUP_2_START },
  { key: "ssd", partNames: SSD_PART_NAMES, revealStart: GROUP_2_START },
  { key: "caseFanA", partNames: CASE_FAN_A_PART_NAMES, revealStart: GROUP_2_START },
  { key: "caseFanB", partNames: CASE_FAN_B_PART_NAMES, revealStart: GROUP_2_START },
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
    color: BLUEPRINT_BASE_COLOR.clone(),
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
  mesh.userData.blueprintBaseColor = BLUEPRINT_BASE_COLOR.getHex();

  const edges = new EdgesGeometry(geom, 15);
  const line = new LineSegments(
    edges,
    new LineBasicMaterial({ color: 0x2c1c12, depthTest: true })
  );

  line.renderOrder = 1;
  mesh.userData.blueprintEdge = line;
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

function formatRpm(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${Math.round(value)} RPM`;
}

function getCaseFanRpm(metrics: MetricsResponse | null): number | null {
  const fans = metrics?.fans ?? [];
  const preferredFan =
    fans.find((fan) => {
      const label = fan.label?.toLowerCase() ?? "";
      return (
        label.includes("motherboard") ||
        label.includes("system") ||
        label.includes("chassis") ||
        label.includes("case")
      );
    }) ??
    fans.find((fan) => {
      const label = fan.label?.toLowerCase() ?? "";
      return !label.includes("processor") && !label.includes("cpu");
    }) ??
    null;

  const rpm = preferredFan?.rpm ?? null;
  return typeof rpm === "number" && Number.isFinite(rpm) && rpm > 0 ? rpm : null;
}

type PanelData = {
  title: string;
  primaryLabel: string;
  primaryValue: string;
  secondaryLabel: string;
  secondaryValue: string;
  percent: number | null;
};

type MobileSummaryRow = {
  label: string;
  value: string;
  aux?: string;
};

type SidebarTelemetryItem = {
  key: PanelKey | null;
  title: string;
  statA: string;
  valueA: string;
  statB?: string;
  valueB?: string;
  load?: string;
  percent: number | null;
};

function appendPercentSuffix(
  value: string,
  percent: number | null | undefined
): string {
  const clamped = clampPercent(percent);
  if (!value || value === "—" || clamped == null) return value;
  return `${value} (${clamped.toFixed(1)}%)`;
}

function extractModelTag(model: string | null | undefined): string | null {
  if (!model || !model.trim()) return null;

  const cleaned = model
    .replace(/_/g, " ")
    .replace(/\(R\)|\(TM\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;

  if (/intel/i.test(cleaned)) return "Intel";
  if (/amd/i.test(cleaned)) return "AMD";
  if (/nvidia/i.test(cleaned)) return "NVIDIA";
  if (/dell/i.test(cleaned)) return "Dell";

  return cleaned.split(" ")[0] ?? null;
}

function buildPartTitle(label: string, model: string | null | undefined): string {
  const tag = extractModelTag(model);
  return tag ? `${label} - ${tag}` : label;
}

function getFanMetricByLabel(
  metrics: MetricsResponse | null,
  kind: "case" | "cpu"
) {
  const fans = metrics?.fans ?? [];

  if (kind === "cpu") {
    return (
      fans.find((fan) => {
        const label = fan.label?.toLowerCase() ?? "";
        return label.includes("processor") || label.includes("cpu");
      }) ?? null
    );
  }

  return (
    fans.find((fan) => {
      const label = fan.label?.toLowerCase() ?? "";
      return (
        label.includes("motherboard") ||
        label.includes("system") ||
        label.includes("chassis") ||
        label.includes("case")
      );
    }) ??
    fans.find((fan) => {
      const label = fan.label?.toLowerCase() ?? "";
      return !label.includes("processor") && !label.includes("cpu");
    }) ??
    null
  );
}

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

function getDiskMetricByLabel(
  metrics: MetricsResponse | null,
  kind: "hdd" | "ssd",
  fallbackIndex: number
) {
  const disks = metrics?.disks ?? [];

  const preferredDisk =
    kind === "ssd"
      ? disks.find((disk) => {
          const label = disk.label?.toLowerCase() ?? "";
          return (
            label.includes("ssd") ||
            label.includes("solid state") ||
            label.includes("nvme")
          );
        })
      : disks.find((disk) => {
          const label = disk.label?.toLowerCase() ?? "";
          return (
            label.includes("hdd") ||
            label.includes("hard disk") ||
            label.includes("spinning")
          );
        });

  return preferredDisk ?? disks[fallbackIndex] ?? null;
}

function extractDiskTelemetry(
  metrics: MetricsResponse | null,
  index: number,
  title: string
): PanelData {
  const disk =
    title === "SSD"
      ? getDiskMetricByLabel(metrics, "ssd", index)
      : title === "HDD"
        ? getDiskMetricByLabel(metrics, "hdd", index)
        : metrics?.disks?.[index] ?? null;

  return {
    title,
    primaryLabel: "Usage",
    primaryValue: formatGigabytes(disk?.used_gb ?? null, disk?.total_gb ?? null),
    secondaryLabel: "Free",
    secondaryValue:
      typeof disk?.free_gb === "number" && Number.isFinite(disk.free_gb)
        ? `${disk.free_gb.toFixed(1)} GB`
        : "—",
    percent: clampPercent(disk?.percent ?? null),
  };
}

function extractFanTelemetry(
  metrics: MetricsResponse | null,
  index: number,
  title: string
): PanelData {
  const fan =
    title === "Case Fan"
      ? getFanMetricByLabel(metrics, "case")
      : title === "CPU Fan"
        ? getFanMetricByLabel(metrics, "cpu")
        : metrics?.fans?.[index] ?? null;

  return {
    title,
    primaryLabel: "Speed",
    primaryValue: formatRpm(fan?.rpm ?? null),
    secondaryLabel: "Controller",
    secondaryValue: fan?.model?.trim() || fan?.label?.trim() || "—",
    percent: clampPercent(fan?.percent ?? null),
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
        "pointer-events-auto absolute z-20 w-[178px] overflow-hidden border md:w-[240px]",
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
          className="cursor-grab border-b border-[#4e3221] bg-[#ead9b7] px-2 py-1.5 active:cursor-grabbing md:px-4 md:py-2"
          onPointerDown={onDragStart}
        >
          <div className="flex items-center justify-start text-[8px] uppercase tracking-[0.16em] text-[#3a2418] md:text-[10px] md:tracking-[0.22em]">
            <span>{data.title}</span>
          </div>
        </div>

        <div
          ref={contentRef}
          className="px-2 py-2 text-[#3a2418] transition-[opacity,transform] duration-300 ease-out md:px-4 md:py-4"
        >
          <div className="grid grid-cols-1 gap-1 md:gap-2">
            <div className="border border-[#4e3221] bg-[#efe1c3] px-2 py-1.5 md:px-3 md:py-3">
              <div className="mb-0.5 text-[8px] uppercase tracking-[0.12em] text-[#6b4a36] md:mb-1 md:text-[10px] md:tracking-[0.18em]">
                {data.primaryLabel}
              </div>
              <div className="font-mono text-sm leading-none tracking-tight text-[#3a2418] md:text-xl">
                {data.primaryValue}
              </div>
            </div>

            <div className="border border-[#4e3221] bg-[#efe1c3] px-2 py-1.5 md:px-3 md:py-3">
              <div className="mb-0.5 text-[8px] uppercase tracking-[0.12em] text-[#6b4a36] md:mb-1 md:text-[10px] md:tracking-[0.18em]">
                {data.secondaryLabel}
              </div>
              <div className="font-mono text-[11px] leading-none tracking-tight text-[#3a2418] md:text-sm">
                {data.secondaryValue}
              </div>
            </div>
          </div>

          <div className="mt-1.5 flex items-center justify-between text-[8px] uppercase tracking-[0.12em] text-[#6b4a36] md:mt-4 md:block md:text-[11px] md:tracking-[0.18em]">
            <span>Load</span>
            <span className="font-mono text-[11px] text-[#3a2418] md:mt-1 md:block md:text-3xl md:leading-none md:tracking-tight">
              {formatPercent(data.percent)}
            </span>
          </div>

          <div className="mt-1.5 h-1.5 border border-[#4e3221] bg-[#e7d7b4] p-[2px] md:mt-2 md:h-2">
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

function MobileSummaryWindow({
  rows,
}: {
  rows: MobileSummaryRow[];
}) {
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20 w-[170px] overflow-hidden border border-[#4e3221] bg-[#f6ead1] text-[#3a2418] shadow-[4px_4px_0_rgba(78,50,33,0.18)] md:hidden">
      <div className="border-b border-[#4e3221] bg-[#ead9b7] px-2 py-1.5 text-[8px] uppercase tracking-[0.16em] text-[#3a2418]">
        Evan&apos;s Server
      </div>
      <div className="grid grid-cols-1 gap-1 px-2 py-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="border border-[#4e3221] bg-[#efe1c3] px-2 py-1.5"
          >
            <div className="flex items-center justify-between gap-2 text-[8px] uppercase tracking-[0.12em] text-[#6b4a36]">
              <span>{row.label}</span>
              {row.aux ? (
                <span className="font-mono normal-case tracking-normal text-[#3a2418]">
                  {row.aux}
                </span>
              ) : null}
            </div>
            <div className="mt-1 font-mono text-[11px] leading-none tracking-tight text-[#3a2418]">
              {row.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DesktopTelemetrySidebar({
  items,
  activeKey,
  highlightHex,
  headerStatus,
  headerRefresh,
  onHoverChange,
  zoomTrackRef,
  zoomScaleFillRef,
  zoomIndicatorRef,
  scrollTrackRef,
  scrollProgressFillRef,
  scrollIndicatorRef,
  onZoomDragStart,
  onScrollDragStart,
}: {
  items: SidebarTelemetryItem[];
  activeKey: PanelKey | null;
  highlightHex: string;
  headerStatus: string;
  headerRefresh: string;
  onHoverChange: (key: PanelKey | null) => void;
  zoomTrackRef: RefObject<HTMLDivElement>;
  zoomScaleFillRef: RefObject<HTMLDivElement>;
  zoomIndicatorRef: RefObject<HTMLDivElement>;
  scrollTrackRef: RefObject<HTMLDivElement>;
  scrollProgressFillRef: RefObject<HTMLDivElement>;
  scrollIndicatorRef: RefObject<HTMLDivElement>;
  onZoomDragStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onScrollDragStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <>
      <div className="pointer-events-auto absolute inset-y-0 left-0 z-30 hidden w-[340px] overflow-hidden border-r border-[#4e3221] bg-[#f6ead1] text-[#3a2418] shadow-[4px_0_0_rgba(78,50,33,0.18)] md:flex md:flex-col">
        <div className="border-b border-[#4e3221] bg-[#ead9b7] px-4 py-3 text-[#3a2418]">
          <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.22em]">
            <span>{headerStatus}</span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-[#6b4a36]">
            <span>Last Refresh</span>
            <span className="font-mono text-[15px] normal-case leading-none tracking-tight text-[#3a2418]">
              {headerRefresh}
            </span>
          </div>
        </div>
      <div className="sidebar-scroll-hidden flex-1 overflow-y-auto px-0 py-0">
        {items.map((item) => {
            const isActive = item.key != null && item.key === activeKey;

            return (
              <div
              key={`${item.key ?? "static"}-${item.title}`}
              className={[
                "border-b px-4 py-2.5 transition-colors",
                isActive
                  ? "border-[#4e3221]"
                  : "border-[#4e3221] bg-[#f6ead1] hover:bg-[#efe1c3]",
              ].join(" ")}
                style={isActive ? { backgroundColor: highlightHex } : undefined}
                onPointerEnter={() => onHoverChange(item.key)}
                onPointerLeave={() => onHoverChange(null)}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="truncate text-[15px] uppercase tracking-[0.14em] text-[#3a2418]">
                    {item.title}
                  </span>
                  {item.load ? (
                    <span className="font-mono text-[14px] text-[#6b4a36]">
                      {item.load}
                    </span>
                  ) : null}
                </div>

                <div className="grid grid-cols-[98px_1fr] gap-x-2 gap-y-1 text-[11px] uppercase tracking-[0.08em] text-[#6b4a36]">
                  <span>{item.statA}</span>
                  <span className="truncate font-mono text-[15px] normal-case tracking-normal text-[#3a2418]">
                    {item.valueA}
                  </span>
                  {item.statB && item.valueB ? (
                    <>
                      <span>{item.statB}</span>
                      <span className="truncate font-mono text-[15px] normal-case tracking-normal text-[#3a2418]">
                        {item.valueB}
                      </span>
                    </>
                  ) : null}
                </div>

                {item.percent != null ? (
                  <div className="mt-2 h-2 overflow-hidden border border-[#4e3221] bg-[#e7d7b4]">
                    <div
                      className="h-full bg-[#6b4a36] transition-[width] duration-300"
                      style={{ width: `${item.percent ?? 0}%` }}
                    />
                  </div>
                ) : null}
              </div>
            );
        })}
      </div>
      <div className="flex min-h-[220px] flex-col justify-center border-t border-[#4e3221] bg-[#ead9b7] px-4 pb-4 pt-4">
        <div className="grid grid-cols-1 gap-3">
          <div className="border border-[#4e3221] bg-[#f6ead1] px-3 py-2 shadow-[4px_4px_0_rgba(78,50,33,0.18)]">
            <div className="mb-2 text-[8px] uppercase tracking-[0.24em] text-[#6b4a36]">
              <span>Zoom</span>
              </div>

              <div className="h-4 border border-[#4e3221] bg-[#efe1c3] p-[3px]">
                <div
                  ref={zoomTrackRef}
                  className="pointer-events-auto relative h-full cursor-pointer overflow-visible"
                  onPointerDown={onZoomDragStart}
                >
                  <div
                    ref={zoomScaleFillRef}
                    className="h-full bg-[#6b4a36] transition-[width] duration-150"
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

          <div className="min-w-0 border border-[#4e3221] bg-[#f6ead1] px-3 py-2 shadow-[4px_4px_0_rgba(78,50,33,0.18)]">
            <div className="mb-2 text-[8px] uppercase tracking-[0.24em] text-[#6b4a36]">
              <span>Scroll</span>
            </div>

              <div className="h-4 border border-[#4e3221] bg-[#efe1c3] p-[3px]">
                <div
                  ref={scrollTrackRef}
                  className="pointer-events-auto relative h-full cursor-pointer overflow-visible"
                  onPointerDown={onScrollDragStart}
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
      </div>
      </div>
    </>
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
  const hddPanelRef = useRef<HTMLDivElement>(null);
  const ssdPanelRef = useRef<HTMLDivElement>(null);
  const caseFanAPanelRef = useRef<HTMLDivElement>(null);
  const caseFanBPanelRef = useRef<HTMLDivElement>(null);
  const cpuShellRef = useRef<HTMLDivElement>(null);
  const ramShellRef = useRef<HTMLDivElement>(null);
  const gpuShellRef = useRef<HTMLDivElement>(null);
  const hddShellRef = useRef<HTMLDivElement>(null);
  const ssdShellRef = useRef<HTMLDivElement>(null);
  const caseFanAShellRef = useRef<HTMLDivElement>(null);
  const caseFanBShellRef = useRef<HTMLDivElement>(null);
  const cpuContentRef = useRef<HTMLDivElement>(null);
  const ramContentRef = useRef<HTMLDivElement>(null);
  const gpuContentRef = useRef<HTMLDivElement>(null);
  const hddContentRef = useRef<HTMLDivElement>(null);
  const ssdContentRef = useRef<HTMLDivElement>(null);
  const caseFanAContentRef = useRef<HTMLDivElement>(null);
  const caseFanBContentRef = useRef<HTMLDivElement>(null);
  const cpuPathRef = useRef<SVGPathElement>(null);
  const ramPathRef = useRef<SVGPathElement>(null);
  const gpuPathRef = useRef<SVGPathElement>(null);
  const hddPathRef = useRef<SVGPathElement>(null);
  const ssdPathRef = useRef<SVGPathElement>(null);
  const caseFanAPathRef = useRef<SVGPathElement>(null);
  const caseFanBPathRef = useRef<SVGPathElement>(null);
  const scrollTrackRef = useRef<HTMLDivElement>(null);
  const scrollProgressFillRef = useRef<HTMLDivElement>(null);
  const scrollIndicatorRef = useRef<HTMLDivElement>(null);
  const scrollProgressLabelRef = useRef<HTMLSpanElement>(null);
  const mobileScrollTrackRef = useRef<HTMLDivElement>(null);
  const mobileScrollProgressFillRef = useRef<HTMLDivElement>(null);
  const mobileScrollIndicatorRef = useRef<HTMLDivElement>(null);
  const mobileScrollProgressLabelRef = useRef<HTMLSpanElement>(null);
  const zoomTrackRef = useRef<HTMLDivElement>(null);
  const zoomScaleFillRef = useRef<HTMLDivElement>(null);
  const zoomIndicatorRef = useRef<HTMLDivElement>(null);
  const zoomScaleLabelRef = useRef<HTMLSpanElement>(null);
  const mobileZoomTrackRef = useRef<HTMLDivElement>(null);
  const mobileZoomScaleFillRef = useRef<HTMLDivElement>(null);
  const mobileZoomIndicatorRef = useRef<HTMLDivElement>(null);
  const mobileZoomScaleLabelRef = useRef<HTMLSpanElement>(null);
  const currentProgressRef = useRef(0);
  const animationProgressRef = useRef(0);
  const metricsRef = useRef<MetricsResponse | null>(metrics);
  const sidebarHoverKeyRef = useRef<PanelKey | null>(null);
  const modelHoverKeyRef = useRef<PanelKey | null>(null);
  const syncSidebarHoverRef = useRef<() => void>(() => {});
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
    axis: "x" | "y";
    invert: boolean;
    track: HTMLDivElement | null;
  } | null>(null);
  const didInitPanelPositionsRef = useRef(false);
  const [sidebarHoverKey, setSidebarHoverKey] = useState<PanelKey | null>(null);
  const [modelHoverKey, setModelHoverKey] = useState<PanelKey | null>(null);

  const cpuTelemetry = useMemo(() => extractCpuTelemetry(metrics), [metrics]);
  const ramTelemetry = useMemo(() => extractRamTelemetry(metrics), [metrics]);
  const gpuTelemetry = useMemo(() => extractGpuTelemetry(metrics), [metrics]);
  const hddTelemetry = useMemo(() => extractDiskTelemetry(metrics, 0, "HDD"), [metrics]);
  const ssdTelemetry = useMemo(() => extractDiskTelemetry(metrics, 1, "SSD"), [metrics]);
  const caseFanATelemetry = useMemo(
    () => extractFanTelemetry(metrics, 0, "Case Fan"),
    [metrics]
  );
  const cpuFanTelemetry = useMemo(
    () => extractFanTelemetry(metrics, 0, "CPU Fan"),
    [metrics]
  );
  const mobileSummaryRows = useMemo<MobileSummaryRow[]>(
    () => [
      {
        label: "CPU",
        value: formatPercent(clampPercent(metrics?.cpu?.percent ?? null)),
        aux: formatTemperature(metrics?.cpu?.temperatures?.[0]?.celsius ?? null),
      },
      {
        label: "RAM",
        value: formatGigabytes(
          metrics?.mem?.used_gb ?? null,
          metrics?.mem?.total_gb ?? null
        ),
        aux: formatPercent(clampPercent(metrics?.mem?.percent ?? null)),
      },
      {
        label: "GPU",
        value: formatGpuTitle(metrics?.gpu?.model ?? null).replace("GPU • ", ""),
        aux: formatTemperature(metrics?.gpu?.temperature_c ?? null),
      },
    ],
    [metrics]
  );
  const sidebarHeaderStatus = useMemo(
    () =>
      `Uptime : ${
        isSystemDown(metrics)
          ? "system down"
          : formatUptime(metrics?.uptime_seconds ?? null)
      }`,
    [metrics]
  );
  const sidebarHeaderRefresh = useMemo(
    () => formatLastRefresh(metrics?.last_updated ?? null),
    [metrics]
  );
  const highlightHex = useMemo(() => getBlueprintHighlightHex(metrics), [metrics]);
  const desktopSidebarItems = useMemo<SidebarTelemetryItem[]>(
    () => [
      {
        key: "cpu",
        title: buildPartTitle("CPU", metrics?.cpu?.model ?? null),
        statA: "Usage",
        valueA: formatPercent(cpuTelemetry.percent),
        load: undefined,
        percent: cpuTelemetry.percent,
      },
      {
        key: "ram",
        title: "RAM",
        statA: ramTelemetry.primaryLabel,
        valueA: appendPercentSuffix(ramTelemetry.primaryValue, ramTelemetry.percent),
        statB: ramTelemetry.secondaryLabel,
        valueB: ramTelemetry.secondaryValue,
        load: undefined,
        percent: ramTelemetry.percent,
      },
      {
        key: "gpu",
        title: buildPartTitle("GPU", metrics?.gpu?.model ?? null),
        statA: gpuTelemetry.primaryLabel,
        valueA: gpuTelemetry.primaryValue,
        statB: gpuTelemetry.secondaryLabel,
        valueB: appendPercentSuffix(gpuTelemetry.secondaryValue, gpuTelemetry.percent),
        load: undefined,
        percent: gpuTelemetry.percent,
      },
      {
        key: "hdd",
        title: "HDD",
        statA: hddTelemetry.primaryLabel,
        valueA: appendPercentSuffix(hddTelemetry.primaryValue, hddTelemetry.percent),
        statB: hddTelemetry.secondaryLabel,
        valueB: hddTelemetry.secondaryValue,
        load: undefined,
        percent: hddTelemetry.percent,
      },
      {
        key: "ssd",
        title: "SSD",
        statA: ssdTelemetry.primaryLabel,
        valueA: appendPercentSuffix(ssdTelemetry.primaryValue, ssdTelemetry.percent),
        statB: ssdTelemetry.secondaryLabel,
        valueB: ssdTelemetry.secondaryValue,
        load: undefined,
        percent: ssdTelemetry.percent,
      },
      {
        key: "caseFanA",
        title: buildPartTitle(
          "Case Fan",
          getFanMetricByLabel(metrics, "case")?.model ?? null
        ),
        statA: caseFanATelemetry.primaryLabel,
        valueA: caseFanATelemetry.primaryValue,
        load: undefined,
        percent: caseFanATelemetry.percent,
      },
      {
        key: "caseFanB",
        title: buildPartTitle(
          "CPU Fan",
          getFanMetricByLabel(metrics, "cpu")?.model ?? null
        ),
        statA: cpuFanTelemetry.primaryLabel,
        valueA: cpuFanTelemetry.primaryValue,
        load: undefined,
        percent: cpuFanTelemetry.percent,
      },
    ],
    [
      metrics,
      cpuTelemetry,
      ramTelemetry,
      gpuTelemetry,
      hddTelemetry,
      ssdTelemetry,
      caseFanATelemetry,
      cpuFanTelemetry,
    ]
  );
  const [panelPositions, setPanelPositions] = useState<Record<PanelKey, PanelPosition>>({
    cpu: { x: PANEL_MARGIN, y: 96 },
    ram: { x: PANEL_MARGIN, y: 96 },
    gpu: { x: PANEL_MARGIN, y: 96 },
    hdd: { x: PANEL_MARGIN, y: 96 },
    ssd: { x: PANEL_MARGIN, y: 96 },
    caseFanA: { x: PANEL_MARGIN, y: 96 },
    caseFanB: { x: PANEL_MARGIN, y: 96 },
  });

  useEffect(() => {
    metricsRef.current = metrics;
  }, [metrics]);

  useEffect(() => {
    sidebarHoverKeyRef.current = sidebarHoverKey;
    syncSidebarHoverRef.current();
  }, [sidebarHoverKey]);

  useEffect(() => {
    modelHoverKeyRef.current = modelHoverKey;
  }, [modelHoverKey]);

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
        const hddHeight = hddPanelRef.current?.getBoundingClientRect().height ?? 280;
        const ssdHeight = ssdPanelRef.current?.getBoundingClientRect().height ?? 280;
        const caseFanAHeight =
          caseFanAPanelRef.current?.getBoundingClientRect().height ?? 280;
        const caseFanBHeight =
          caseFanBPanelRef.current?.getBoundingClientRect().height ?? 280;

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
        const desiredBottomX = Math.max(PANEL_MARGIN, desiredRamX);
        const nextHdd = {
          x: didInitPanelPositionsRef.current
            ? clamp(
                current.hdd.x,
                PANEL_MARGIN,
                Math.max(PANEL_MARGIN, overlayRect.width - PANEL_WIDTH - PANEL_MARGIN)
              )
            : PANEL_MARGIN,
          y: didInitPanelPositionsRef.current
            ? clamp(
                current.hdd.y,
                PANEL_MARGIN,
                Math.max(PANEL_MARGIN, overlayRect.height - hddHeight - PANEL_MARGIN)
              )
            : Math.max(PANEL_MARGIN, overlayRect.height - hddHeight - 164),
        };
        const nextSsd = {
          x: didInitPanelPositionsRef.current
            ? clamp(
                current.ssd.x,
                PANEL_MARGIN,
                Math.max(PANEL_MARGIN, overlayRect.width - PANEL_WIDTH - PANEL_MARGIN)
              )
            : PANEL_MARGIN,
          y: didInitPanelPositionsRef.current
            ? clamp(
                current.ssd.y,
                PANEL_MARGIN,
                Math.max(PANEL_MARGIN, overlayRect.height - ssdHeight - PANEL_MARGIN)
              )
            : Math.max(PANEL_MARGIN, overlayRect.height - ssdHeight - 44),
        };
        const nextCaseFanA = {
          x: didInitPanelPositionsRef.current
            ? clamp(
                current.caseFanA.x,
                PANEL_MARGIN,
                Math.max(PANEL_MARGIN, overlayRect.width - PANEL_WIDTH - PANEL_MARGIN)
              )
            : desiredBottomX,
          y: didInitPanelPositionsRef.current
            ? clamp(
                current.caseFanA.y,
                PANEL_MARGIN,
                Math.max(PANEL_MARGIN, overlayRect.height - caseFanAHeight - PANEL_MARGIN)
              )
            : Math.max(PANEL_MARGIN, overlayRect.height - caseFanAHeight - 164),
        };
        const nextCaseFanB = {
          x: didInitPanelPositionsRef.current
            ? clamp(
                current.caseFanB.x,
                PANEL_MARGIN,
                Math.max(PANEL_MARGIN, overlayRect.width - PANEL_WIDTH - PANEL_MARGIN)
              )
            : desiredBottomX,
          y: didInitPanelPositionsRef.current
            ? clamp(
                current.caseFanB.y,
                PANEL_MARGIN,
                Math.max(PANEL_MARGIN, overlayRect.height - caseFanBHeight - PANEL_MARGIN)
              )
            : Math.max(PANEL_MARGIN, overlayRect.height - caseFanBHeight - 44),
        };

        const nextCpuAdjusted = didInitPanelPositionsRef.current
          ? nextCpu
          : {
              x: PANEL_MARGIN,
              y: Math.max(PANEL_MARGIN, Math.min(96, overlayRect.height - cpuHeight - PANEL_MARGIN)),
            };

        didInitPanelPositionsRef.current = true;
        return {
          cpu: nextCpuAdjusted,
          ram: nextRam,
          gpu: nextGpu,
          hdd: nextHdd,
          ssd: nextSsd,
          caseFanA: nextCaseFanA,
          caseFanB: nextCaseFanB,
        };
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
            : dragState.panel === "gpu"
              ? gpuPanelRef.current
              : dragState.panel === "hdd"
                ? hddPanelRef.current
                : dragState.panel === "ssd"
                  ? ssdPanelRef.current
                  : dragState.panel === "caseFanA"
                    ? caseFanAPanelRef.current
                    : caseFanBPanelRef.current;
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
      const track = dragState.track;
      if (!track) return;

      const rect = track.getBoundingClientRect();
      const rawProgress =
        dragState.axis === "x"
          ? (event.clientX - rect.left) / Math.max(1, rect.width)
          : (event.clientY - rect.top) / Math.max(1, rect.height);
      const progress = clamp(dragState.invert ? 1 - rawProgress : rawProgress, 0, 1);

      if (dragState.control === "scroll") {
        setScrollProgressRef.current(progress);
      } else {
        setZoomProgressRef.current(progress);
      }
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
    scene.background = new Color(0xead9b7);

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
    const hoverBaseQuaternion = new Map<string, Quaternion>();
    const hoverPickTargets: Object3D[] = [];
    const layoutAnchorWorld = new Map<string, { position: Vector3; quaternion: Quaternion }>();
    const flatLayoutPartToGroup = new Map<string, string>();
    const flatLayoutBaseCenterWorld = new Map<string, Vector3>();
    const telemetryAnchorWorld = new Map<PanelKey, Vector3>();
    const spinningFanBaseRotations = new Map<
      string,
      { x: number; y: number; z: number }
    >();

    let maxDistance = 0.45;
    let rootGroup: Group | null = null;
    let disposed = false;
    let raf = 0;

    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    const hoverRaycaster = new Raycaster();
    const hoverPointer = new Vector2();

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

      if (name === "BackPower") {
        return [GROUP_3_START, GROUP_3_END];
      }

      if (name === "Side_right") {
        return [GROUP_4_START, GROUP_4_END];
      }

      if (name === "Side_left") {
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

      panel.style.opacity = "1";
      panel.style.visibility = "visible";
      panel.style.pointerEvents = "auto";

      if (shell) {
        const originX = endPoint
          ? `${clamp(((endPoint.x - (panelRect.left - overlayRect.left)) / Math.max(1, panelRect.width)) * 100, 0, 100)}%`
          : "50%";
        const originY = endPoint
          ? `${clamp(((endPoint.y - (panelRect.top - overlayRect.top)) / Math.max(1, panelRect.height)) * 100, 0, 100)}%`
          : "50%";

        shell.style.setProperty("--panel-origin-x", originX);
        shell.style.setProperty("--panel-origin-y", originY);
        shell.style.transform = "scale(1)";
        shell.style.opacity = "1";
      }

      if (content) {
        content.style.opacity = "1";
        content.style.transform = "translateY(0px)";
      }
    };

    const updateHud = () => {
      const scrollProgress = targetProgress;
      const scrollFill = scrollProgressFillRef.current;
      const scrollIndicator = scrollIndicatorRef.current;
      const mobileScrollFill = mobileScrollProgressFillRef.current;
      const mobileScrollIndicator = mobileScrollIndicatorRef.current;
      const zoomFill = zoomScaleFillRef.current;
      const zoomIndicator = zoomIndicatorRef.current;
      const mobileZoomFill = mobileZoomScaleFillRef.current;
      const mobileZoomIndicator = mobileZoomIndicatorRef.current;

      if (scrollFill) {
        scrollFill.style.width = `${scrollProgress * 100}%`;
      }

      if (scrollIndicator) {
        scrollIndicator.style.left = `${scrollProgress * 100}%`;
      }

      if (mobileScrollFill) {
        mobileScrollFill.style.height = `${scrollProgress * 100}%`;
      }

      if (mobileScrollIndicator) {
        mobileScrollIndicator.style.bottom = `${scrollProgress * 100}%`;
      }

      const zoomRange = Math.max(0.0001, controls.maxDistance - controls.minDistance);
      const zoomDistance = camera.position.distanceTo(controls.target);
      const zoomProgress = clamp01((controls.maxDistance - zoomDistance) / zoomRange);

      if (zoomFill) {
        zoomFill.style.width = `${zoomProgress * 100}%`;
      }

      if (zoomIndicator) {
        zoomIndicator.style.left = `${zoomProgress * 100}%`;
      }

      if (mobileZoomFill) {
        mobileZoomFill.style.height = `${zoomProgress * 100}%`;
      }

      if (mobileZoomIndicator) {
        mobileZoomIndicator.style.bottom = `${zoomProgress * 100}%`;
      }

    };

    const updateTelemetryOverlay = () => {
      const panelRefs: Record<PanelKey, HTMLDivElement | null> = {
        cpu: cpuPanelRef.current,
        ram: ramPanelRef.current,
        gpu: gpuPanelRef.current,
        hdd: hddPanelRef.current,
        ssd: ssdPanelRef.current,
        caseFanA: caseFanAPanelRef.current,
        caseFanB: caseFanBPanelRef.current,
      };
      const shellRefs: Record<PanelKey, HTMLDivElement | null> = {
        cpu: cpuShellRef.current,
        ram: ramShellRef.current,
        gpu: gpuShellRef.current,
        hdd: hddShellRef.current,
        ssd: ssdShellRef.current,
        caseFanA: caseFanAShellRef.current,
        caseFanB: caseFanBShellRef.current,
      };
      const contentRefs: Record<PanelKey, HTMLDivElement | null> = {
        cpu: cpuContentRef.current,
        ram: ramContentRef.current,
        gpu: gpuContentRef.current,
        hdd: hddContentRef.current,
        ssd: ssdContentRef.current,
        caseFanA: caseFanAContentRef.current,
        caseFanB: caseFanBContentRef.current,
      };
      const pathRefs: Record<PanelKey, SVGPathElement | null> = {
        cpu: cpuPathRef.current,
        ram: ramPathRef.current,
        gpu: gpuPathRef.current,
        hdd: hddPathRef.current,
        ssd: ssdPathRef.current,
        caseFanA: caseFanAPathRef.current,
        caseFanB: caseFanBPathRef.current,
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
        const hoverDirection = HOVER_DIRECTIONS[name] ?? WORLD_UP;
        const layoutProgress = getPhaseProgress(
          progress,
          FLAT_LAYOUT_START,
          FLAT_LAYOUT_END
        );
        const layoutGroupKey = flatLayoutPartToGroup.get(name);
        const targetWorld = base.clone();

        if (layoutGroupKey) {
          const groupBaseCenter = flatLayoutBaseCenterWorld.get(layoutGroupKey);
          const anchor = layoutAnchorWorld.get(layoutGroupKey);

          if (groupBaseCenter && anchor) {
            const relativeOffset = base.clone().sub(groupBaseCenter);
            const layoutTargetWorld = anchor.position.clone().add(relativeOffset);
            targetWorld.lerp(layoutTargetWorld, layoutProgress);

            const baseQuaternion =
              hoverBaseQuaternion.get(name)?.clone() ?? obj.quaternion.clone();
            obj.quaternion.copy(baseQuaternion).slerp(anchor.quaternion, layoutProgress);
          }
        } else {
          const baseQuaternion =
            hoverBaseQuaternion.get(name)?.clone() ?? obj.quaternion.clone();
          obj.quaternion.copy(baseQuaternion);
        }

        targetWorld.addScaledVector(hoverDirection, curOffset);
        const hoverAmount = clamp01(curOffset / Math.max(HOVER_PARTS[name] ?? 0.05, 0.0001));
        const localPos = targetWorld.clone();
        obj.parent.worldToLocal(localPos);
        obj.position.copy(localPos);

        obj.scale.copy(origScale);
        obj.visible = true;

        obj.traverse((child) => {
          if (!(child instanceof Mesh)) return;
          const material = child.material;
          if (!(material instanceof MeshBasicMaterial)) return;
          const baseColor = new Color(
            typeof child.userData.blueprintBaseColor === "number"
              ? child.userData.blueprintBaseColor
              : BLUEPRINT_BASE_COLOR.getHex()
          );
          material.color
            .copy(baseColor)
            .lerp(getBlueprintHighlightColor(metricsRef.current), hoverAmount);
        });
      }

      const spinTime = performance.now() * 0.001;
      for (const config of SPINNING_FAN_CONFIGS) {
        for (const fanName of config.names) {
          const fan = hoverMap.get(fanName) ?? rootGroup.getObjectByName(fanName);
          if (!fan) continue;

          const orientedQuaternion = fan.quaternion.clone();

          if (config.speed === 0 && config.metricKind) {
            const rpm =
              config.metricKind === "cpu"
                ? getFanMetricByLabel(metricsRef.current, "cpu")?.rpm ?? null
                : getFanMetricByLabel(metricsRef.current, "case")?.rpm ?? null;
            if (!rpm) {
              continue;
            }

            const liveAngularSpeed = rpm * RPM_TO_RAD_PER_SEC;
            const spinQuaternion = new Quaternion().setFromAxisAngle(
              getSpinAxisVector(config.axis),
              spinTime * liveAngularSpeed
            );
            fan.quaternion.copy(orientedQuaternion).multiply(spinQuaternion);
            continue;
          }

          const spinQuaternion = new Quaternion().setFromAxisAngle(
            getSpinAxisVector(config.axis),
            spinTime * config.speed
          );
          fan.quaternion.copy(orientedQuaternion).multiply(spinQuaternion);
        }
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
        if (target === 0 && current < 0.002) {
          hoverCurrent.set(name, 0);
          continue;
        }

        const smoothing = target === 0 ? 0.28 : 0.08;
        hoverCurrent.set(name, current + (target - current) * smoothing);
      }

      controls.update();
      updateTelemetryOverlay();
      updateHud();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };

    const setHoverTargets = (hoveredNames: Set<string>) => {
      const hoverEnabled = animationProgressRef.current >= FLAT_LAYOUT_START;
      if (!hoverEnabled) {
        hoveredNames = new Set<string>();
      }

      const sidebarKey = sidebarHoverKeyRef.current;
      const sidebarConfig = sidebarKey
        ? PANEL_CONFIGS.find((config) => config.key === sidebarKey)
        : null;

      let nextModelHoverKey: PanelKey | null = null;

      if (CPU_COOLER_HOVER_PART_NAMES.some((name) => hoveredNames.has(name))) {
        nextModelHoverKey = "caseFanB";
      } else if (hoveredNames.has("CaseFan") || hoveredNames.has("CaseFan001")) {
        nextModelHoverKey = "caseFanA";
      } else if (hoveredNames.has("HDD")) {
        nextModelHoverKey = "hdd";
      } else if (hoveredNames.has("SSD")) {
        nextModelHoverKey = "ssd";
      } else if (GPU_PART_NAMES.some((name) => hoveredNames.has(name))) {
        nextModelHoverKey = "gpu";
      } else if (CPU_PART_NAMES.some((name) => hoveredNames.has(name))) {
        nextModelHoverKey = "cpu";
      } else if (RAM_PART_NAMES.some((name) => hoveredNames.has(name))) {
        nextModelHoverKey = "ram";
      }

      if (modelHoverKeyRef.current !== nextModelHoverKey) {
        modelHoverKeyRef.current = nextModelHoverKey;
        setModelHoverKey(nextModelHoverKey);
      }

      if (sidebarConfig) {
        for (const partName of sidebarConfig.partNames) {
          hoveredNames.add(partName);
        }
      }

      let cpuHovered = false;
      let cpuCoolerHovered = false;
      let gpuHovered = false;
      let caseFanHovered = false;

      for (const [name] of hoverMap) {
        const hovered = hoveredNames.has(name);

        if (CPU_CORE_PART_NAMES.includes(name)) {
          cpuHovered ||= hovered;
          continue;
        }

        if (CPU_COOLER_HOVER_PART_NAMES.includes(name)) {
          cpuCoolerHovered ||= hovered;
          continue;
        }

        if (GPU_PART_NAMES.includes(name)) {
          gpuHovered ||= hovered;
          continue;
        }

        if (CASE_FAN_HOVER_PART_NAMES.includes(name)) {
          caseFanHovered ||= hovered;
          continue;
        }

        hoverTarget.set(name, hovered ? HOVER_PARTS[name] ?? 0.05 : 0);
      }

      for (const cpuName of CPU_CORE_PART_NAMES) {
        if (!hoverMap.has(cpuName)) continue;
        hoverTarget.set(cpuName, cpuHovered ? HOVER_PARTS[cpuName] ?? 0.05 : 0);
      }

      for (const cpuCoolerName of CPU_COOLER_HOVER_PART_NAMES) {
        if (!hoverMap.has(cpuCoolerName)) continue;
        hoverTarget.set(
          cpuCoolerName,
          cpuCoolerHovered ? HOVER_PARTS[cpuCoolerName] ?? 0.05 : 0
        );
      }

      for (const gpuName of GPU_PART_NAMES) {
        if (!hoverMap.has(gpuName)) continue;
        hoverTarget.set(gpuName, gpuHovered ? HOVER_PARTS[gpuName] ?? 0.05 : 0);
      }

      for (const fanName of CASE_FAN_HOVER_PART_NAMES) {
        if (!hoverMap.has(fanName)) continue;
        hoverTarget.set(fanName, caseFanHovered ? HOVER_PARTS[fanName] ?? 0.05 : 0);
      }
    };

    const getHoverRootName = (object: Object3D | null): string | null => {
      let current: Object3D | null = object;

      while (current) {
        if (hoverMap.has(current.name)) {
          return current.name;
        }
        current = current.parent;
      }

      return null;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!rootGroup || hoverMap.size === 0) return;

      const rect = renderer.domElement.getBoundingClientRect();
      const hoveredNames = new Set<string>();

      hoverPointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        ((e.clientY - rect.top) / rect.height) * -2 + 1
      );
      hoverRaycaster.setFromCamera(hoverPointer, camera);

      const intersections = hoverRaycaster.intersectObjects(hoverPickTargets, true);

      for (const intersection of intersections) {
        if (!(intersection.object instanceof Mesh)) continue;

        const hoverName = getHoverRootName(intersection.object);
        if (!hoverName) continue;

        hoveredNames.add(hoverName);
        break;
      }

      setHoverTargets(hoveredNames);
    };

    syncSidebarHoverRef.current = () => {
      setHoverTargets(new Set<string>());
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
        motherboardCenter.x - dist * 0.55,
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

        const flatLayoutGroup = FLAT_LAYOUT_GROUPS_BY_NORMALIZED_ANCHOR.get(
          normalizeSceneName(n)
        );
        if (flatLayoutGroup) {
          const anchorWorldPosition = new Vector3();
          const anchorWorldQuaternion = new Quaternion();
          child.getWorldPosition(anchorWorldPosition);
          child.getWorldQuaternion(anchorWorldQuaternion);
          layoutAnchorWorld.set(flatLayoutGroup.key, {
            position: anchorWorldPosition,
            quaternion: anchorWorldQuaternion,
          });
          child.visible = false;
          return;
        }

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
        hoverBaseQuaternion.set(name, obj.quaternion.clone());
        hoverTarget.set(name, 0);
        hoverCurrent.set(name, 0);
        hoverPickTargets.push(obj);
        obj.traverse((child) => {
          if (!(child instanceof Mesh)) return;
          const edge = child.userData.blueprintEdge;
          if (!(edge instanceof LineSegments)) return;
          edge.scale.setScalar(1.01);
        });
      }

      for (const group of FLAT_LAYOUT_GROUPS) {
        const groupPositions = group.partNames
          .map((partName) => hoverBaseWorld.get(partName)?.clone() ?? null)
          .filter((value): value is Vector3 => value != null);

        if (groupPositions.length === 0 || !layoutAnchorWorld.has(group.key)) continue;

        const center = groupPositions.reduce(
          (acc, point) => acc.add(point),
          new Vector3()
        );
        center.multiplyScalar(1 / groupPositions.length);
        flatLayoutBaseCenterWorld.set(group.key, center);

        for (const partName of group.partNames) {
          if (!hoverMap.has(partName)) continue;
          flatLayoutPartToGroup.set(partName, group.key);
        }
      }

      for (const config of SPINNING_FAN_CONFIGS) {
        for (const fanName of config.names) {
          const fan = hoverMap.get(fanName) ?? rootGroup.getObjectByName(fanName);
          if (!fan) continue;

          spinningFanBaseRotations.set(fanName, {
            x: fan.rotation.x,
            y: fan.rotation.y,
            z: fan.rotation.z,
          });
        }
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
      setHoverTargets(new Set<string>());
    });

    return () => {
      disposed = true;
      syncSidebarHoverRef.current = () => {};
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
            : panel === "gpu"
              ? gpuPanelRef.current
              : panel === "hdd"
                ? hddPanelRef.current
                : panel === "ssd"
                  ? ssdPanelRef.current
                  : panel === "caseFanA"
                    ? caseFanAPanelRef.current
                    : caseFanBPanelRef.current;
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
    (
      control: "scroll" | "zoom",
      axis: "x" | "y",
      invert: boolean,
      trackRef: RefObject<HTMLDivElement>
    ) =>
    (event: ReactPointerEvent<HTMLDivElement>) => {
      hudDragStateRef.current = {
        control,
        pointerId: event.pointerId,
        axis,
        invert,
        track: trackRef.current,
      };

      const track = trackRef.current;
      if (track) {
        const rect = track.getBoundingClientRect();
        const rawProgress =
          axis === "x"
            ? (event.clientX - rect.left) / Math.max(1, rect.width)
            : (event.clientY - rect.top) / Math.max(1, rect.height);
        const progress = clamp(invert ? 1 - rawProgress : rawProgress, 0, 1);

        if (control === "scroll") {
          setScrollProgressRef.current(progress);
        } else {
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
      <div className="sticky top-0 z-0 flex min-h-screen w-full flex-col overflow-hidden relative">
        <DesktopTelemetrySidebar
          items={desktopSidebarItems}
          activeKey={sidebarHoverKey ?? modelHoverKey}
          highlightHex={highlightHex}
          headerStatus={sidebarHeaderStatus}
          headerRefresh={sidebarHeaderRefresh}
          onHoverChange={setSidebarHoverKey}
          zoomTrackRef={zoomTrackRef}
          zoomScaleFillRef={zoomScaleFillRef}
          zoomIndicatorRef={zoomIndicatorRef}
          scrollTrackRef={scrollTrackRef}
          scrollProgressFillRef={scrollProgressFillRef}
          scrollIndicatorRef={scrollIndicatorRef}
          onZoomDragStart={startHudDrag("zoom", "x", false, zoomTrackRef)}
          onScrollDragStart={startHudDrag("scroll", "x", false, scrollTrackRef)}
        />
        <div className="relative z-10 border-t border-brownBorder/70 bg-[#ead9b7] px-4 py-3 text-center text-xs uppercase tracking-wider text-brownMuted">
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
            <div className="pointer-events-none absolute inset-y-0 left-0 right-0 z-20 flex items-center justify-between px-4 md:hidden">
              <div className="border border-[#4e3221] bg-[#f6ead1] px-2 py-3 shadow-[4px_4px_0_rgba(78,50,33,0.18)]">
                <div className="mb-2 text-[8px] uppercase tracking-[0.24em] text-[#6b4a36] [writing-mode:vertical-rl]">
                  <span>Zoom</span>
                </div>
                <div className="flex h-40 w-4 items-end border border-[#4e3221] bg-[#efe1c3] p-[3px]">
                  <div
                    ref={mobileZoomTrackRef}
                    className="pointer-events-auto relative h-full w-full cursor-pointer overflow-visible"
                    onPointerDown={startHudDrag("zoom", "y", true, mobileZoomTrackRef)}
                  >
                    <div
                      ref={mobileZoomScaleFillRef}
                      className="absolute bottom-0 left-0 w-full bg-[#6b4a36] transition-[height] duration-150"
                      style={{ height: "0%" }}
                    />
                    <div
                      ref={mobileZoomIndicatorRef}
                      className="absolute left-1/2 h-[3px] w-[calc(100%+8px)] -translate-x-1/2 bg-[#ead9b7] shadow-[0_0_0_1px_#4e3221] transition-[bottom] duration-150"
                      style={{ bottom: "0%" }}
                    />
                  </div>
                </div>
              </div>

              <div className="border border-[#4e3221] bg-[#f6ead1] px-2 py-3 shadow-[4px_4px_0_rgba(78,50,33,0.18)]">
                <div className="mb-2 text-[8px] uppercase tracking-[0.24em] text-[#6b4a36] [writing-mode:vertical-rl]">
                  <span>Scroll</span>
                </div>
                <div className="flex h-40 w-4 items-end border border-[#4e3221] bg-[#efe1c3] p-[3px]">
                  <div
                    ref={mobileScrollTrackRef}
                    className="pointer-events-auto relative h-full w-full cursor-pointer overflow-visible"
                    onPointerDown={startHudDrag("scroll", "y", true, mobileScrollTrackRef)}
                  >
                    <div
                      ref={mobileScrollProgressFillRef}
                      className="absolute bottom-0 left-0 w-full bg-[#6b4a36] transition-[height] duration-150"
                      style={{ height: "0%" }}
                    />
                    <div
                      ref={mobileScrollIndicatorRef}
                      className="absolute left-1/2 h-[3px] w-[calc(100%+8px)] -translate-x-1/2 bg-[#ead9b7] shadow-[0_0_0_1px_#4e3221] transition-[bottom] duration-150"
                      style={{ bottom: "0%" }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <MobileSummaryWindow rows={mobileSummaryRows} />
          </div>
        </div>
      </div>
    </section>
  );
}
