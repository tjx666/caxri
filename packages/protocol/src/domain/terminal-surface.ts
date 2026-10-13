import { z } from 'zod';

import { agentProviderCatalog } from '../agent/agents.js';
import type { TerminalKind } from './terminal-record.js';

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

/**
 * Whether `kind` can start as an Agent Chat: an Agent whose provider catalog entry declares `capabilities.chat`. Every
 * creation path (Server validation and every Renderer entry point) asks this one predicate.
 */
export function canUseAgentChat(kind: TerminalKind): boolean {
    return kind !== 'shell' && agentProviderCatalog[kind].capabilities.chat;
}
