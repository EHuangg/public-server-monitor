"use client";

import { createTimeline } from "animejs";
import { useEffect, useRef } from "react";
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

const MODEL_URL =
  process.env.NEXT_PUBLIC_SERVER_CASE_GLB ?? "/models/server-case.glb";

/**
 * Coordinate convention:
 * (X, Z, Y) -> (forwards, upwards, sideways)
 *
 * Leaving scene convention untouched. Top/Bottom are intentionally kept on Y
 * because that matches how this model is currently oriented in your scene.
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

// Animation constants
const DVD_PREROLL_DIST = 0.5;
const DVD_TRAY_DIST = 0.08;

// Everyone stops at the same hard distance.
const STOP_DISTANCE_MULT = 2.2;

const DVD_PREROLL_END = 0.2;

const GROUP_DURATION = 0.24;
const GROUP_OFFSET = GROUP_DURATION * 0.25; // smaller gap / heavier overlap

// Start the normal explode earlier, but keep the page-load pose at zero progress.
const GROUP_2_START = 0.0667; // Back, remaining Front layers
const GROUP_2_END = GROUP_2_START + GROUP_DURATION;

const GROUP_1_START = GROUP_2_START - GROUP_OFFSET; // DVD, DVDDrive
const GROUP_1_END = GROUP_1_START + GROUP_DURATION;

const GROUP_3_START = GROUP_2_START + GROUP_OFFSET; // Side_right
const GROUP_3_END = GROUP_3_START + GROUP_DURATION;

const GROUP_4_START = GROUP_3_START + GROUP_OFFSET; // Side_left
const GROUP_4_END = GROUP_4_START + GROUP_DURATION;

const GROUP_5_START = GROUP_4_START + GROUP_OFFSET; // BackPower
const GROUP_5_END = GROUP_5_START + GROUP_DURATION;

const GROUP_6_START = GROUP_5_START + GROUP_OFFSET; // Top, Bottom
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
    new LineBasicMaterial({ color: 0x020007, depthTest: true })
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
  // Leave current scene behavior untouched:
  // top/bottom are intentionally on Y for this model
  if (name === "Top") return new Vector3(0, 1, 0);
  if (name === "Bottom") return new Vector3(0, -1, 0);

  // both side layers go -X
  if (name === "Side_left" || name === "Side_right") {
    return new Vector3(-1, 0, 0);
  }

  // front layers go +X
  if (name === "Front" || name.startsWith("FrontPanel")) {
    return new Vector3(1, 0, 0);
  }

  return getExplodeWorldDirection(name as any).clone();
}

export default function ServerCaseBlueprint() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const pinRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = canvasMountRef.current;
    const section = sectionRef.current;
    const pin = pinRef.current;
    if (!container || !section) return;

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

    const updateCasePositions = (progress: number) => {
      if (!rootGroup) return;

      // standard exploding parts
      for (const [name, obj] of partsMap) {
        const bw = baseWorld.get(name);
        const wd = worldDir.get(name);
        const origScale = originalScales.get(name) || new Vector3(1, 1, 1);

        if (!bw || !wd || !obj.parent) continue;

        const [start, end] = getWindowForPart(name);
        const phase = getPhaseProgress(progress, start, end);

        const targetWorld = bw.clone().addScaledVector(
          wd,
          phase * maxDistance
        );

        const localPos = targetWorld.clone();
        obj.parent.worldToLocal(localPos);
        obj.position.copy(localPos);

        obj.scale.copy(origScale);
        obj.visible = true;
      }

      // DVD + DVD drive
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

            // preroll forward first
            pos.addScaledVector(DVD_FORWARD_AXIS, DVD_PREROLL_DIST * preP);

            // tray rises and keeps moving +X during the same preroll segment
            if (isTray && preP > 0.5) {
              const trayLift = (preP - 0.5) / 0.5;
              pos.addScaledVector(DVD_TRAY_AXIS, DVD_TRAY_DIST * trayLift);
              pos.addScaledVector(DVD_FORWARD_AXIS, DVD_PREROLL_DIST * trayLift);
            }

            // then both move to the same hard stop distance
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

      // hover-only internal parts
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

      if (pin && rootGroup) {
        const testPart =
          partsMap.get("Front") ?? Array.from(partsMap.values())[0];

        if (testPart) {
          const wp = new Vector3();
          testPart.getWorldPosition(wp);

          const { x, y, visible } = projectWorldToScreen(
            wp,
            camera,
            renderer.domElement.width,
            renderer.domElement.height
          );

          pin.style.opacity = visible ? "1" : "0.3";
          pin.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
        }
      }

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
        const obj = (collected as any)[name];
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

      onScroll();
      loop();
      window.dispatchEvent(new Event("resize"));
    });

    const resize = () => {
      renderer.setSize(container.clientWidth, container.clientHeight);
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
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
      renderer.dispose();
      scene.clear();
    };
  }, []);

  return (
    <section ref={sectionRef} className="relative w-full min-h-[440vh]">
      <div className="sticky top-0 z-0 flex min-h-screen w-full flex-col overflow-hidden">
        <div className="border-t border-brownBorder/70 bg-creamBg px-4 py-3 text-center text-xs uppercase tracking-wider text-brownMuted">
          Home Server Dashboard — Active Monitoring
        </div>

        <div className="relative flex-1 w-full">
          <div ref={canvasMountRef} className="absolute inset-0" />

          <div
            ref={pinRef}
            className="pointer-events-none absolute left-0 top-0 z-10 rounded border border-brownBorder bg-creamCard/95 px-3 py-2 text-xs text-brownInk shadow-md transition-opacity duration-300"
          >
            <strong>SYSTEM CORE</strong>
            <br /> Status: Active
          </div>
        </div>
      </div>
    </section>
  );
}