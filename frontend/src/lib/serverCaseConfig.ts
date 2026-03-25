import type { Group, Object3D } from "three";
import { Euler, Vector3 } from "three";

/** Blender object names for the case (logical keys used in code). */
export const CASE_OBJECT_NAMES = [
  "Front",
  "Front.Panel",
  "Front.Panel.001",
  "Front.Panel.002",
  "Front.Panel.003",
  "Back",
  "Top",
  "Bottom",
  "Side_Left",
  "Side_Right"
] as const;

export type CaseObjectName = (typeof CASE_OBJECT_NAMES)[number];

/**
 * World-space slide direction (Three.js: Y up, right-handed).
 * Front / panels → +X | Back → −X
 * Side_Left → −Y | Side_Right → +Y
 * Bottom → −Z | Top → +Z
 */
export const CASE_EXPLODE_WORLD: Record<CaseObjectName, [number, number, number]> = {
  Front:           [1,  0,  0],
  "Front.Panel":   [1,  0,  0],
  "Front.Panel.001": [1, 0, 0],
  "Front.Panel.002": [1, 0, 0],
  "Front.Panel.003": [1, 0, 0],
  Back:            [-1, 0,  0],
  Top:             [0,  1,  0],  // was [0, 0,  1]
  Bottom:          [0, -1,  0],  // was [0, 0, -1]
  Side_Left:       [0,  0,  1],  // was [0, -1, 0]
  Side_Right:      [0,  0, -1],  // was [0,  1, 0]
};

/** Extra names to try if `getObjectByName` fails (Blender / glTF naming varies). */
export const CASE_NAME_ALIASES: Partial<Record<CaseObjectName, string[]>> = {
  "Front.Panel": ["Front_Panel", "Front Panel"],
  "Front.Panel.001": [
    "Front_Panel.001",
    "Front_Panel_001",
    "Front Panel.001",
    "Pannel.001",
    "pannel.001",
    "Panel.001"
  ],
  "Front.Panel.002": [
    "Front_Panel.002",
    "Front_Panel_002",
    "Front Panel.002",
    "Pannel.002",
    "pannel.002",
    "Panel.002"
  ],
  "Front.Panel.003": [
    "Front_Panel.003",
    "Front_Panel_003",
    "Front Panel.003",
    "Pannel.003",
    "pannel.003",
    "Panel.003"
  ],
  Side_Left: ["Side Left", "Side-Left"],
  Side_Right: ["Side Right", "Side-Right"]
};

function normalizeForMatch(name: string): string {
  return name
    .toLowerCase()
    .replace(/_/g, ".")
    .replace(/\s+/g, "")
    .replace(/-/g, "");
}

/**
 * Find an object by exact name, aliases, normalized equality, or numbered panel patterns.
 */
export function resolveCasePart(root: Object3D, canonical: CaseObjectName): Object3D | null {
  const direct = root.getObjectByName(canonical);
  if (direct) return direct;

  const aliases = CASE_NAME_ALIASES[canonical];
  if (aliases) {
    for (const a of aliases) {
      const o = root.getObjectByName(a);
      if (o) return o;
    }
  }

  const targetNorm = normalizeForMatch(canonical);
  let found: Object3D | null = null;
  root.traverse((obj) => {
    if (found) return;
    if (normalizeForMatch(obj.name) === targetNorm) found = obj;
  });
  if (found) return found;

  const panelNum = canonical.match(/Front\.Panel\.(\d+)$/i)?.[1];
  if (panelNum) {
    const n = panelNum.replace(/^0+/, "") || panelNum;
    const patterns = [
      new RegExp(`^Front[._]Panel[._]?0*${panelNum}$`, "i"),
      new RegExp(`^Front[._]Panel[._]?0*${n}$`, "i"),
      new RegExp(`^Pannel[._]?0*${panelNum}$`, "i"),
      new RegExp(`^pannel[._]?0*${panelNum}$`, "i"),
      new RegExp(`^Panel[._]?0*${panelNum}$`, "i")
    ];
    root.traverse((obj) => {
      if (found) return;
      for (const p of patterns) {
        if (p.test(obj.name)) {
          found = obj;
          return;
        }
      }
    });
  }

  return found;
}

export function collectCaseParts(root: Group): Partial<Record<CaseObjectName, Object3D>> {
  const map: Partial<Record<CaseObjectName, Object3D>> = {};
  for (const name of CASE_OBJECT_NAMES) {
    const obj = resolveCasePart(root, name);
    if (obj) {
      map[name] = obj;
    }
  }
  return map;
}

/**
 * Slide directions in Three.js world space (Y up):
 * Front / panels +X, Back −X, Side_Left −Y, Side_Right +Y, Bottom −Z, Top +Z.
 *
 * If your GLB is authored in Blender, the mesh may be rotated vs world; set
 * NEXT_PUBLIC_CASE_AXIS_YAW_DEGREES (e.g. 90 or -90) so these match what you see.
 */
export function getExplodeWorldDirection(name: string): Vector3 {
  const tuple = CASE_EXPLODE_WORLD[name as CaseObjectName];
  const v = tuple ? new Vector3(tuple[0], tuple[1], tuple[2]) : new Vector3(1, 0, 0);
  v.normalize();
  const yawDeg = Number(process.env.NEXT_PUBLIC_CASE_AXIS_YAW_DEGREES ?? 0);
  if (Number.isFinite(yawDeg) && yawDeg !== 0) {
    const euler = new Euler(0, (yawDeg * Math.PI) / 180, 0, "YXZ");
    v.applyEuler(euler);
    v.normalize();
  }
  return v;
}

/** Future: blueprint styling for internal components. */
export function isPartNode(obj: Object3D): boolean {
  return obj.name.startsWith("Part_");
}
