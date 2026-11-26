/**
 * Compile-time proof that a tool cannot skip the lane decision. `tsc` fails if a
 * `@ts-expect-error` below stops being an error, i.e. if `defineTool` loosens.
 */
import { defineTool } from './define.js';

export const complete = defineTool({
  name: 'x',
  class: 'read',
  lanes: { stdio: true, remote: false, next: false },
});

// @ts-expect-error no lanes at all
export const noLanes = defineTool({ name: 'x', class: 'read' });

// @ts-expect-error one lane missing: `next` has no decision
export const oneLaneMissing = defineTool({ name: 'x', class: 'read', lanes: { stdio: true, remote: false } });

// @ts-expect-error no class
export const noClass = defineTool({ name: 'x', lanes: { stdio: true, remote: false, next: false } });
