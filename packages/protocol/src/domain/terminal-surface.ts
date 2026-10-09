import { z } from 'zod';

/**
 * How a Terminal presents its process, fixed at creation. `pty` runs the Shell or Agent CLI in a real pseudo-terminal;
 * `chat` runs a supported Agent CLI through its vendor's structured protocol and renders a conversation (ADR 0012).
 */
export const terminalSurfaceSchema = z.enum(['pty', 'chat']);
export type TerminalSurface = z.infer<typeof terminalSurfaceSchema>;

/**
 * Whether a Terminal runs through a structured Agent Chat instead of a PTY. Every PTY-only operation checks this one
 * predicate so a Chat Terminal is rejected at a single, named boundary.
 */
export function isChatTerminal(terminal: { surface?: TerminalSurface }): boolean {
    return terminal.surface === 'chat';
}
