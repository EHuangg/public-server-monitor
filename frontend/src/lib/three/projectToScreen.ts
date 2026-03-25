import type { Camera } from "three";
import { Vector3 } from "three";

/**
 * Project a world-space point to normalized device coordinates, then to CSS pixels
 * relative to the renderer's canvas (top-left origin).
 */
export function projectWorldToScreen(
  worldPoint: Vector3,
  camera: Camera,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number; visible: boolean } {
  const v = worldPoint.clone().project(camera);
  const visible = v.z > -1 && v.z < 1;
  const x = (v.x * 0.5 + 0.5) * canvasWidth;
  const y = (-v.y * 0.5 + 0.5) * canvasHeight;
  return { x, y, visible };
}
