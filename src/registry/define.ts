import type { Lane, ToolMeta } from './types.js';

/**
 * Identity at runtime; the point is the constraint. `M` must carry `class` and a
 * full `lanes` object, so a tool without a lane decision does not compile
 * (`registry/lanes.type-check.ts` keeps a `@ts-expect-error` on it).
 */
export function defineTool<M extends ToolMeta>(def: M): M {
  return def;
}

/** The tools a lane serves, in registration order. */
export function forLane<M extends ToolMeta>(tools: readonly M[], lane: Lane): M[] {
  return tools.filter((t) => t.lanes[lane]);
}
