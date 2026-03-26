"use client";

import { createTimeline } from "animejs";
import { useEffect, useRef } from "react";
import {
  Box3,
  Color,
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
  Euler
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { projectWorldToScreen } from "@/lib/three/projectToScreen";
import { CASE_OBJECT_NAMES, collectCaseParts, getExplodeWorldDirection } from "@/lib/serverCaseConfig";

const MODEL_URL = process.env.NEXT_PUBLIC_SERVER_CASE_GLB ?? "/models/server-case.glb";

/**
 * CONSISTENT COORDINATE SYSTEM DEFINITION:
 * ---------------------------------------
 * WORLD_UP: The global 'Up' direction for hover lifting (Z-up).
 * DVD_FORWARD_AXIS: Local axis for "Front" movement (Preroll & Explode).
 * DVD_TRAY_AXIS: Local axis for the Tray sliding out (Side-to-side in Blender).
 */
const WORLD_UP = new Vector3(0, 0, 1);
const DVD_FORWARD_AXIS = new Vector3(1, 0, 0); // Local X
const DVD_TRAY_AXIS    = new Vector3(0, 1, 0); // Local Y (Confirmed via Console)

const HOVER_PARTS: Record<string, number> = {
  RAM:    0.04,
  RAM001: 0.04,
  RAM002: 0.04,
  RAM003: 0.04,
  CPU:    0.05,
  CPU001: 0.08,
};

// Animation Constants
const DVD_PREROLL_DIST = 0.50;
const DVD_TRAY_DIST    = 0.08;
const DVD_SPEED_MULT   = 1.25;
const BACK_POWER_SPEED = 0.65;
const DVD_PRE_END      = 0.15;
const DVD_TRAY_SUB     = 0.5;

function applyBlueprintStyle(mesh: Mesh): void {
  const geom = mesh.geometry;
  if (!geom) return;
  const mat = new MeshBasicMaterial({
    color: 0xfdf4df,
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

export default function ServerCaseBlueprint() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const sectionRef     = useRef<HTMLElement | null>(null);
  const pinRef         = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = canvasMountRef.current;
    const section   = sectionRef.current;
    const pin       = pinRef.current;
    if (!container || !section) return;

    // --- State & Smoothing ---
    let targetProgress  = 0;
    let currentProgress = 0;
    const lerpAmount    = 0.05;

    // --- Three.js Core ---
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
    controls.enableZoom    = false;

    // --- Animation Timeline ---
    const tl = createTimeline({ autoplay: false });
    const scrollState = { p: 0 };
    tl.add(scrollState, { p: [0, 1], duration: 1000, ease: "linear" });

    // --- Data Maps ---
    const partsMap    = new Map<string, Object3D>(); // Standard explode
    const hoverMap    = new Map<string, Object3D>(); // Hover-only
    const baseWorld   = new Map<string, Vector3>();  // World origin for explode
    const worldDir    = new Map<string, Vector3>();  // Normalized world direction
    const speedMult   = new Map<string, number>();   // Speed scaling
    const dvdBaseLocal = new Map<string, Vector3>(); // Local origin for DVD parts
    const hoverTarget  = new Map<string, number>();  // Hover lift target
    const hoverCurrent = new Map<string, number>();  // Hover lift current
    const hoverBaseWorld = new Map<string, Vector3>(); // World origin for hover

    let maxDistance = 0.45;
    let rootGroup: Group | null = null;

    const updateCasePositions = (progress: number) => {
      if (!rootGroup) return;

      const mainProgress = Math.max(0, (progress - DVD_PRE_END) / (1 - DVD_PRE_END));

      // 1. Standard Explode Parts (World-to-Local conversion)
      for (const [name, obj] of partsMap) {
        const bw = baseWorld.get(name);
        const wd = worldDir.get(name);
        const speed = speedMult.get(name) ?? 1;
        if (!bw || !wd || !obj.parent) continue;

        const targetWorld = bw.clone().addScaledVector(wd, mainProgress * maxDistance * speed);
        const localPos = targetWorld.clone();
        obj.parent.worldToLocal(localPos);
        obj.position.copy(localPos);
      }

      // 2. DVD Mechanics (Unified Local Coordinate Logic)
      const dvdDrive = rootGroup.getObjectByName("FrontPanelDVDDrive");
      const dvdTray  = rootGroup.getObjectByName("FrontPanelDVD");

      if (dvdDrive && dvdTray) {
        const driveBase = dvdBaseLocal.get("FrontPanelDVDDrive");
        const trayBase  = dvdBaseLocal.get("FrontPanelDVD");

        if (driveBase && trayBase) {
          const preP = Math.min(1, progress / DVD_PRE_END);
          const trayP = Math.max(0, (preP - DVD_TRAY_SUB) / (1 - DVD_TRAY_SUB));

          const getDvdPos = (base: Vector3, isTray: boolean) => {
            const pos = base.clone();
          
            // 1. Preroll/Forward phase (Both move forward together)
            pos.addScaledVector(DVD_FORWARD_AXIS, DVD_PREROLL_DIST * preP);
          
            // 2. Tray side-slide (Only the tray slides on Y)
            if (isTray) {
              pos.addScaledVector(DVD_TRAY_AXIS, DVD_TRAY_DIST * trayP);
            }
          
            // 3. Explode phase (Divergent Speeds)
            if (progress > DVD_PRE_END) {
              // If it's the tray, use a higher multiplier (e.g., 2.5)
              // If it's the drive housing, use the standard DVD_SPEED_MULT (1.25)
              const multiplier = isTray ? (DVD_SPEED_MULT * 2.5) : DVD_SPEED_MULT;
              
              pos.addScaledVector(DVD_FORWARD_AXIS, mainProgress * maxDistance * multiplier);
            }
          
            return pos;
          };

          dvdDrive.position.copy(getDvdPos(driveBase, false));
          dvdTray.position.copy(getDvdPos(trayBase, true));
        }
      }

      // 3. Hover Parts (World Space vertical lift)
      for (const [name, obj] of hoverMap) {
        const base = hoverBaseWorld.get(name);
        if (!base || !obj.parent) continue;
        const curOffset = hoverCurrent.get(name) ?? 0;
        const targetWorld = base.clone().addScaledVector(WORLD_UP, curOffset);
        const localPos = targetWorld.clone();
        obj.parent.worldToLocal(localPos);
        obj.position.copy(localPos);
      }
    };

    const getSectionScrollProgress = (): number => {
      const rect = section.getBoundingClientRect();
      const vh   = window.innerHeight;
      if (rect.top >= vh) return 0;
      if (rect.bottom <= 0) return 1;
      const total = vh + rect.height;
      const scrolled = vh - rect.top;
      const raw = Math.min(1, Math.max(0, scrolled / Math.max(1, total)));
      const delay = 0.33;
      return Math.min(1, Math.max(0, (raw - delay) / (1 - delay)));
    };

    const onScroll = () => { targetProgress = getSectionScrollProgress(); };

    const loop = () => {
      if (disposed) return;

      currentProgress += (targetProgress - currentProgress) * lerpAmount;
      tl.seek(currentProgress * tl.duration);
      updateCasePositions(currentProgress);

      // Smooth Hover Lerping
      for (const [name] of hoverMap) {
        const target  = hoverTarget.get(name)  ?? 0;
        const current = hoverCurrent.get(name) ?? 0;
        hoverCurrent.set(name, current + (target - current) * 0.08);
      }

      // Sync Screen Pin to System Core
      if (pin && rootGroup) {
        const testPart = partsMap.get("Front") ?? Array.from(partsMap.values())[0];
        if (testPart) {
          const wp = new Vector3();
          testPart.getWorldPosition(wp);
          const { x, y, visible } = projectWorldToScreen(wp, camera, renderer.domElement.width, renderer.domElement.height);
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
        const { x: sx, y: sy } = projectWorldToScreen(wp, camera, renderer.domElement.width, renderer.domElement.height);
        const ndcX = (sx / renderer.domElement.width) * 2 - 1;
        const ndcY = (sy / renderer.domElement.height) * -2 + 1;
        const hovered = Math.hypot(nx - ndcX, ny - ndcY) < 0.12;
        hoverTarget.set(name, hovered ? (HOVER_PARTS[name] ?? 0.05) : 0);
      }
    };

    // --- Loading Logic ---
    const loader = new GLTFLoader();
    let disposed = false;
    let raf = 0;

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

      const explodeScale = Math.max(0.25, Number(process.env.NEXT_PUBLIC_CASE_EXPLODE_SCALE ?? 1));
      maxDistance = Math.max(maxDim * 8, camera.position.length() * 2) * explodeScale;

      // 1. Map canonical parts
      const collected = collectCaseParts(rootGroup);
      for (const name of CASE_OBJECT_NAMES) {
        const obj = (collected as any)[name];
        if (obj) partsMap.set(name, obj);
      }

      // 2. Traversal for dynamic parts
      rootGroup.traverse((child) => {
        const n = child.name;
        if (!n) return;

        if (n in HOVER_PARTS) {
          hoverMap.set(n, child);
          partsMap.delete(n); // Ensure no double-mapping
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

      // 3. Finalize World Data
      rootGroup.updateMatrixWorld(true);
      for (const [name, obj] of partsMap) {
        const bw = new Vector3();
        obj.getWorldPosition(bw);
        baseWorld.set(name, bw);
        worldDir.set(name, getExplodeWorldDirection(name));
        if (name === "BackPower") speedMult.set(name, BACK_POWER_SPEED);
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
      // maintains the aspect ratio of the canvas
      window.dispatchEvent(new Event('resize'));
    });

    // --- Cleanup ---
    const resize = () => {
      renderer.setSize(container.clientWidth, container.clientHeight);
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", resize);
    renderer.domElement.addEventListener("mousemove", onMouseMove);
    renderer.domElement.addEventListener("mouseleave", () => {
      for (const [name] of hoverMap) hoverTarget.set(name, 0);
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
    <section ref={sectionRef} className="relative w-full min-h-[250vh]">
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