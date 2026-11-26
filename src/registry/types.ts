/**
 * Registry vocabulary (spec 011 T4). Every tool belongs to one class and carries
 * an explicit yes/no for each lane; there is no default, so adding a tool forces
 * the decision at compile time (`define.ts`).
 *
 * Types only plus two constant tuples: this file is reachable from the remote
 * entry and imports nothing.
 */
export const TOOL_CLASSES = ['read', 'account-read', 'onboarding', 'money', 'control'] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

/** stdio = the local server, remote = read-only HTTP server, next = the Next.js adapter. */
export const LANES = ['stdio', 'remote', 'next'] as const;
export type Lane = (typeof LANES)[number];

/** All three keys are required: a missing lane is a type error, not a silent "no". */
export type LaneFlags = { readonly [L in Lane]: boolean };

export interface ToolMeta {
  readonly name: string;
  readonly class: ToolClass;
  readonly lanes: LaneFlags;
}
