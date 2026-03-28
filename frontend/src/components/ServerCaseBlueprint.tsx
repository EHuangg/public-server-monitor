"use client";

import { createTimeline } from "animejs";
import { useEffect, useMemo, useRef, type RefObject } from "react";
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
};

const RAM_PART_NAMES = ["RAM", "RAM001", "RAM002", "RAM003"];
const CPU_PART_NAMES = ["CPU", "CPU001"];

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

function TelemetryWindow({
  data,
  align = "left",
  innerRef,
}: {
  data: PanelData;
  align?: "left" | "right";
  innerRef: RefObject<HTMLDivElement>;
}) {
  return (
    <div
      ref={innerRef}
      className={[
        "pointer-events-none absolute z-20 w-[240px] overflow-hidden border",
        "border-[#4e3221] bg-[#f6ead1] text-[#3a2418]",
        "shadow-[4px_4px_0_rgba(78,50,33,0.18)]",
        align === "left"
          ? "left-8 top-24 md:left-12 md:top-20"
          : "right-8 top-24 md:right-12 md:top-20",
      ].join(" ")}
    >
      <div className="border-b border-[#4e3221] bg-[#ead9b7] px-4 py-2">
        <div className="flex items-center justify-start text-[10px] uppercase tracking-[0.22em] text-[#3a2418]">
          <span>{data.title}</span>
        </div>
      </div>

      <div className="px-4 py-4 text-[#3a2418]">
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
  );
}

export default function ServerCaseBlueprint({
  metrics,
}: {
  metrics: MetricsResponse | null;
}) {
  const canvasMountRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const cpuPanelRef = useRef<HTMLDivElement>(null);
  const ramPanelRef = useRef<HTMLDivElement>(null);
  const cpuPathRef = useRef<SVGPathElement>(null);
  const ramPathRef = useRef<SVGPathElement>(null);

  const cpuTelemetry = useMemo(() => extractCpuTelemetry(metrics), [metrics]);
  const ramTelemetry = useMemo(() => extractRamTelemetry(metrics), [metrics]);

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

    const tl = createTimeline({ autoplay: false });
    const scrollState = { p: 0 };
    tl.add(scrollState, { p: [0, 1], duration: 1000, ease: "linear" });

    const partsMap = new Map<string, Object3D>();
    const hoverMap = new Map<string, Object3D>();
    const originalScales = new Map<string, Vector3>();

    const baseWorld = new Map<string, Vector3>();
    const worldDir = new Map<string, Vector3>();
    const dvdBaseLocal = new Map<string, Vector3>();
    const hoverTarget = new Map<string, number>();
    const hoverCurrent = new Map<string, number>();
    const hoverBaseWorld = new Map<string, Vector3>();
    const telemetryAnchorWorld = new Map<"cpu" | "ram", Vector3>();

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
      anchor: { x: number; y: number; visible: boolean } | null,
      side: "left" | "right"
    ) => {
      if (!path || !panel || !anchor) return;

      const overlayRect = overlay.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();

      const panelEdgeX =
        side === "left"
          ? panelRect.right - overlayRect.left
          : panelRect.left - overlayRect.left;

      const panelY = panelRect.top - overlayRect.top + panelRect.height * 0.5;
      const elbowX = side === "left" ? anchor.x - 40 : anchor.x + 40;

      const d = [
        `M ${anchor.x} ${anchor.y}`,
        `L ${elbowX} ${anchor.y}`,
        `L ${elbowX} ${panelY}`,
        `L ${panelEdgeX} ${panelY}`,
      ].join(" ");

      path.setAttribute("d", d);
      path.style.opacity = anchor.visible ? "1" : "0";
    };

    const updateTelemetryOverlay = () => {
      const cpuAnchorWorld = telemetryAnchorWorld.get("cpu");
      const ramAnchorWorld = telemetryAnchorWorld.get("ram");

      const cpuAnchor = cpuAnchorWorld
        ? projectWorldToScreen(
            cpuAnchorWorld,
            camera,
            renderer.domElement.width,
            renderer.domElement.height
          )
        : null;

      const ramAnchor = ramAnchorWorld
        ? projectWorldToScreen(
            ramAnchorWorld,
            camera,
            renderer.domElement.width,
            renderer.domElement.height
          )
        : null;

      setConnectorPath(cpuPathRef.current, cpuPanelRef.current, cpuAnchor, "left");
      setConnectorPath(ramPathRef.current, ramPanelRef.current, ramAnchor, "right");
    };

    const updateCasePositions = (progress: number) => {
      if (!rootGroup) return;

      for (const [name, obj] of partsMap) {
        const bw = baseWorld.get(name);
        const wd = worldDir.get(name);
        const origScale = originalScales.get(name) || new Vector3(1, 1, 1);

        if (!bw || !wd || !obj.parent) continue;

        const [start, end] = getWindowForPart(name);
        const phase = getPhaseProgress(progress, start, end);

        const targetWorld = bw.clone().addScaledVector(wd, phase * maxDistance);

        const localPos = targetWorld.clone();
        obj.parent.worldToLocal(localPos);
        obj.position.copy(localPos);

        obj.scale.copy(origScale);
        obj.visible = true;
      }

      const dvdDrive = rootGroup.getObjectByName("FrontPanelDVDDrive");
      const dvdTray = rootGroup.getObjectByName("FrontPanelDVD");

      if (dvdDrive && dvdTray) {
        const driveBase = dvdBaseLocal.get("FrontPanelDVDDrive");
        const trayBase = dvdBaseLocal.get("FrontPanelDVD");
        const driveOrigScale =
          originalScales.get("FrontPanelDVDDrive") || new Vector3(1, 1, 1);
        const trayOrigScale =
          originalScales.get("FrontPanelDVD") || new Vector3(1, 1, 1);

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
          dvdDrive.scale.copy(driveOrigScale);
          dvdTray.scale.copy(trayOrigScale);
          dvdDrive.visible = true;
          dvdTray.visible = true;
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
    };

    const getSectionScrollProgress = (): number => {
      const rect = section.getBoundingClientRect();
      const vh = window.innerHeight;
      const totalScrollable = Math.max(1, rect.height - vh);
      const scrolled = Math.min(totalScrollable, Math.max(0, -rect.top));
      return clamp01(scrolled / totalScrollable);
    };

    const onScroll = () => {
      targetProgress = getSectionScrollProgress();
    };

    const loop = () => {
      if (disposed) return;

      currentProgress += (targetProgress - currentProgress) * lerpAmount;

      if (Math.abs(targetProgress - currentProgress) < 0.0005) {
        currentProgress = targetProgress;
      }

      tl.seek(currentProgress * tl.duration);
      updateCasePositions(currentProgress);

      for (const [name] of hoverMap) {
        const target = hoverTarget.get(name) ?? 0;
        const current = hoverCurrent.get(name) ?? 0;
        hoverCurrent.set(name, current + (target - current) * 0.08);
      }

      updateTelemetryOverlay();

      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!rootGroup || hoverMap.size === 0) return;

      const rect = renderer.domElement.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = ((e.clientY - rect.top) / rect.height) * -2 + 1;

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

        hoverTarget.set(name, hovered ? HOVER_PARTS[name] ?? 0.05 : 0);
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

      camera.position.set(dist * 0.55, dist * 0.35, dist * 0.65);
      camera.lookAt(0, 0, 0);

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
          dvdBaseLocal.set(n, child.position.clone());
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

      const cpuStart = getAverageWorldPosition(CPU_PART_NAMES);
      const ramStart = getAverageWorldPosition(RAM_PART_NAMES);

      if (cpuStart) telemetryAnchorWorld.set("cpu", cpuStart.clone());
      if (ramStart) telemetryAnchorWorld.set("ram", ramStart.clone());

      onScroll();
      loop();
      window.dispatchEvent(new Event("resize"));
    });

    const resize = () => {
      renderer.setSize(container.clientWidth, container.clientHeight);
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      updateTelemetryOverlay();
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

  return (
    <section ref={sectionRef} className="relative w-full min-h-[270vh]">
      <div className="sticky top-0 z-0 flex min-h-screen w-full flex-col overflow-hidden">
        <div className="border-t border-brownBorder/70 bg-creamBg px-4 py-3 text-center text-xs uppercase tracking-wider text-brownMuted">
          <a href="https://evan-huang.dev" className="hover:underline">
            Evan
          </a>
          's Server | pls dont hack me pls I need this
        </div>

        <div className="relative flex-1 w-full">
          <div ref={canvasMountRef} className="absolute inset-0" />

          <div
            ref={overlayRef}
            className="pointer-events-none absolute inset-0 z-10"
          >
            <svg className="absolute inset-0 h-full w-full overflow-visible">
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
            </svg>

            <TelemetryWindow
              data={cpuTelemetry}
              align="left"
              innerRef={cpuPanelRef}
            />

            <TelemetryWindow
              data={ramTelemetry}
              align="right"
              innerRef={ramPanelRef}
            />
          </div>
        </div>
      </div>
    </section>
  );
}