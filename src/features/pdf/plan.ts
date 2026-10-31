/**
 * The page plan: what the new PDF will contain. It starts as the open document's pages in order
 * and is changed by reordering, rotating and deleting. Nothing touches the file until Save Copy
 * turns the plan into a job. All functions are pure.
 */
export type Rotation = 0 | 90 | 180 | 270;

export interface PlanPage {
  /** Stable identity while the plan is edited (React keys, selection, dragging). */
  id: number;
  /** Page of the source document, from 1. */
  src: number;
  /** Degrees clockwise added to the source page's own rotation. */
  rot: Rotation;
}

export const identity = (count: number): PlanPage[] => Array.from({ length: count }, (_, i) => ({ id: i + 1, src: i + 1, rot: 0 }));

export const isIdentity = (plan: PlanPage[], count: number): boolean => plan.length === count && plan.every((p, i) => p.src === i + 1 && p.rot === 0);

const turn = (rot: Rotation, by: number): Rotation => ((((rot + by) % 360) + 360) % 360) as Rotation;

export function rotate(plan: PlanPage[], ids: ReadonlySet<number>, by: 90 | -90 | 180): PlanPage[] {
  return plan.map((p) => (ids.has(p.id) ? { ...p, rot: turn(p.rot, by) } : p));
}

/** Remove pages. Never removes the last one: a PDF needs at least one page. */
export function remove(plan: PlanPage[], ids: ReadonlySet<number>): PlanPage[] {
  const kept = plan.filter((p) => !ids.has(p.id));
  return kept.length === 0 ? plan : kept;
}

/** Move the chosen pages one place earlier (-1) or later (+1), keeping their order among themselves. */
export function moveBy(plan: PlanPage[], ids: ReadonlySet<number>, dir: -1 | 1): PlanPage[] {
  const next = [...plan];
  const order = dir < 0 ? next.keys() : [...next.keys()].reverse();
  for (const i of order) {
    const j = i + dir;
    if (ids.has(next[i].id) && j >= 0 && j < next.length && !ids.has(next[j].id)) [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

/** Move the chosen pages, as one block, so they sit before position `at` (0 = first, plan.length = last). */
export function moveBlock(plan: PlanPage[], ids: ReadonlySet<number>, at: number): PlanPage[] {
  const moving = plan.filter((p) => ids.has(p.id));
  const rest = plan.filter((p) => !ids.has(p.id));
  // `at` counts positions in the plan as it was; discount the moving pages that sat before it.
  const before = plan.slice(0, at).filter((p) => ids.has(p.id)).length;
  const to = Math.max(0, Math.min(rest.length, at - before));
  return [...rest.slice(0, to), ...moving, ...rest.slice(to)];
}

/** What a job needs: the source page and extra rotation for each page, in order. */
export const toJobPages = (plan: PlanPage[]) => plan.map((p) => ({ page: p.src, rotate: p.rot }));

/** A page's size as shown, after turning. */
export const turned = <T extends { width_pt: number; height_pt: number }>(info: T, rot: Rotation): T => (rot % 180 === 0 ? info : { ...info, width_pt: info.height_pt, height_pt: info.width_pt });
