import type { Group, Object3D } from "three";
import { Euler, Vector3 } from "three";

/**
 * EXACT node names as exported by the GLB (Blender strips dots → camelCase).
 * Verified from the console dump:
 *   Top, Side_left, Side_right, Back, Bottom, Front,
 *   FrontPanel, FrontPanel001, FrontPanel002, FrontPanel003,
 *   FrontPanelDVD (Group), FrontPanelDVDDrive,
 *   MotherBoard, BackPower,
 *   CPU, CPU001, RAM, RAM001, RAM002, RAM003
 *
 * Note: Side_left / Side_right keep the underscore but use lowercase l/r.
 */
export const CASE_OBJECT_NAMES = [
  "Front",
  "FrontPanel",
  "FrontPanel001",
  "FrontPanel002",
  "FrontPanel003",
  "Back",
  "Top",
  "Bottom",
  "Side_left",
  "Side_right",
] as const;

export type CaseObjectName = (typeof CASE_OBJECT_NAMES)[number];

/**
 * World-space explode directions (Three.js: Y-up, right-handed).
 *
 * Adjust NEXT_PUBLIC_CASE_AXIS_YAW_DEGREES if the GLB is rotated in world space.
 *
 * Current layout (looking at the front of the server):
 *   Front panels  → +X
 *   Back          → −X
 *   Top           → +Y
 *   Bottom        → −Y
 *   Side_left     → −Z
 *   Side_right    → +Z
 */
const CASE_EXPLODE_WORLD: Record<CaseObjectName, [number, number, number]> = {
  Front:          [ 1,  0,  0],
  FrontPanel:     [ 1,  0,  0],
  FrontPanel001:  [ 1,  0,  0],
  FrontPanel002:  [ 1,  0,  0],
  FrontPanel003:  [ 1,  0,  0],
  Back:           [-1,  0,  0],
  Top:            [ 0,  1,  0],
  Bottom:         [ 0, -1,  0],
  Side_left:      [ 0,  0,  1], 
  Side_right:     [ 0,  0, -1], 
};

/**
 * Collect case parts directly by exact GLB name.
 * No fuzzy matching needed — names are now ground-truth from the console dump.
 */
export function collectCaseParts(root: Group): Partial<Record<CaseObjectName, Object3D>> {
  const map: Partial<Record<CaseObjectName, Object3D>> = {};
  for (const name of CASE_OBJECT_NAMES) {
    const obj = root.getObjectByName(name);
    if (obj) {
      map[name] = obj;
    }
  }
  return map;
}

/**
 * Returns the normalised world-space explode direction for a given part name.
 *
 * Handles all GLB node names including the ones managed outside CASE_OBJECT_NAMES
 * (BackPower, FrontPanelDVD, FrontPanelDVDDrive, CPU, CPU001, RAM–RAM003).
 *
 * Falls back to +X if the name is unrecognised.
 */
export function getExplodeWorldDirection(name: string): Vector3 {
  // Direct lookup in the main table first
  const tuple = CASE_EXPLODE_WORLD[name as CaseObjectName];

  // Extended lookup for parts not in CASE_OBJECT_NAMES
  const EXTRA: Record<string, [number, number, number]> = {
    BackPower:          [-1,  0,  0],   // same axis as Back
    FrontPanelDVD:      [ 1,  0,  0],   // same axis as Front
    FrontPanelDVDDrive: [ 1,  0,  0],   // same axis as Front
    // RAM and CPU are hover-only and never call getExplodeWorldDirection,
    // but define them here as a safety net so a zero-vector is never returned.
    RAM:    [0, 1, 0],
    RAM001: [0, 1, 0],
    RAM002: [0, 1, 0],
    RAM003: [0, 1, 0],
    CPU:    [0, 1, 0],
    CPU001: [0, 1, 0],
  };

  const resolved = tuple ?? EXTRA[name];
  const v = resolved
    ? new Vector3(resolved[0], resolved[1], resolved[2])
    : new Vector3(1, 0, 0); // fallback: +X

  v.normalize();

  const yawDeg = Number(process.env.NEXT_PUBLIC_CASE_AXIS_YAW_DEGREES ?? 0);
  if (Number.isFinite(yawDeg) && yawDeg !== 0) {
    v.applyEuler(new Euler(0, (yawDeg * Math.PI) / 180, 0, "YXZ"));
    v.normalize();
  }

  return v;
}

/** Future: blueprint styling for internal components. */
export function isPartNode(obj: Object3D): boolean {
  return obj.name.startsWith("Part_");
}