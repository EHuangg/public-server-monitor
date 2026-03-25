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
  WebGLRenderer
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { projectWorldToScreen } from "@/lib/three/projectToScreen";
import { CASE_OBJECT_NAMES, collectCaseParts, getExplodeWorldDirection } from "@/lib/serverCaseConfig";

const MODEL_URL = process.env.NEXT_PUBLIC_SERVER_CASE_GLB ?? "/models/server-case.glb";

function applyBlueprintStyle(mesh: Mesh): void {
  const geom = mesh.geometry;
  if (!geom) return;

  const mat = new MeshBasicMaterial({
    color: 0xffffff,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1
  });
  mesh.material = mat;

  const edges = new EdgesGeometry(geom, 15);
  const line = new LineSegments(
    edges,
    new LineBasicMaterial({ color: 0x000000, depthTest: true })
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
  const sectionRef = useRef<HTMLElement | null>(null);
  const pinRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = canvasMountRef.current;
    const section = sectionRef.current;
    const pin = pinRef.current;
    if (!container || !section) return;

    // --- SCROLL SMOOTHING STATE ---
    let targetProgress = 0;
    let currentProgress = 0;
    const lerpAmount = 0.05; // Adjust this (0.01 to 0.1) for more/less "delay"

    const scene = new Scene();
    scene.background = new Color(0xfbf6ee);

    const camera = new PerspectiveCamera(45, 1, 0.01, 500);
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xfbf6ee, 1);
    
    // Styling the canvas
    Object.assign(renderer.domElement.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        zIndex: "0"
    });
    container.appendChild(renderer.domElement);

    // Set correct size immediately so lines render sharp at full resolution
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableZoom = false;

    const scrollState = { p: 0 };
    const tl = createTimeline({ autoplay: false });
    tl.add(scrollState, { p: [0, 1], duration: 1000, ease: "linear" });

    // Use a plain string map so we can store extra objects (e.g. Front.Panel variants)
    // that may not be listed in CASE_OBJECT_NAMES
    const partsMap = new Map<string, Object3D>();
    const baseWorld = new Map<string, Vector3>();
    const worldDir = new Map<string, Vector3>();
    let maxDistance = 0.45;
    let rootGroup: Group | null = null;

    const updateCasePositions = (progress: number) => {
      if (!rootGroup) return;
      for (const [name, obj] of partsMap) {
        const bw = baseWorld.get(name);
        const wd = worldDir.get(name);
        if (!bw || !wd) continue;
        const parent = obj.parent;
        if (!parent) continue;

        const targetWorld = bw.clone().addScaledVector(wd, progress * maxDistance);
        const local = targetWorld.clone();
        parent.worldToLocal(local);
        obj.position.copy(local);
      }
    };

    const getSectionScrollProgress = (): number => {
      const rect = section.getBoundingClientRect();
      const vh = window.innerHeight;
      if (rect.top >= vh) return 0;
      if (rect.bottom <= 0) return 1;
      const total = vh + rect.height;
      const scrolled = vh - rect.top;
      const raw = Math.min(1, Math.max(0, scrolled / Math.max(1, total)));

      // Delay: first ~33% of scroll range (≈ 1 viewport on a 250vh section) does nothing
      const delay = 0.33;
      return Math.min(1, Math.max(0, (raw - delay) / (1 - delay)));
    };

    const onScroll = () => {
      targetProgress = getSectionScrollProgress();
    };

    const loop = () => {
      if (disposed) return;

      // 1. Smoothly interpolate (Lerp) the progress
      currentProgress += (targetProgress - currentProgress) * lerpAmount;

      // 2. Update Timeline and 3D positions using smoothed progress
      tl.seek(currentProgress * tl.duration);
      updateCasePositions(currentProgress);

      // 3. Update the UI Pin position
      if (pin && rootGroup) {
        const testPart = partsMap.get("Front") ?? partsMap.values().next().value;
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

      // Populate from config-defined names
      const collected = collectCaseParts(rootGroup);
      for (const name of CASE_OBJECT_NAMES) {
        const obj = (collected as Record<string, Object3D | undefined>)[name];
        if (obj) partsMap.set(name, obj);
      }

      // Also traverse the scene to pick up Front.Panel variants that may
      // not be listed in CASE_OBJECT_NAMES (e.g. Front.Panel.001/.002/.003)
      rootGroup.traverse((child) => {
        if (child.name.startsWith("Front") && !partsMap.has(child.name)) {
          partsMap.set(child.name, child);
        }
      });

      // Setup World Positions and Directions
      rootGroup.updateMatrixWorld(true);
      for (const [name, obj] of partsMap) {
        const bw = new Vector3();
        obj.getWorldPosition(bw);
        baseWorld.set(name, bw);

        // Front, Front.Panel, Front.Panel.001/.002/.003 all share the same direction
        if (name.startsWith("Front")) {
          worldDir.set(name, getExplodeWorldDirection("Front"));
        } else {
          worldDir.set(name, getExplodeWorldDirection(name));
        }
      }

      onScroll();
      loop();
    });

    const resize = () => {
      renderer.setSize(container.clientWidth, container.clientHeight);
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", resize);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", resize);
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
