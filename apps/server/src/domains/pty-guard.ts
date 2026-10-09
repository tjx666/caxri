import type { TerminalSurface } from '@caxri/protocol';
import { CaxriError, isChatTerminal } from '@caxri/protocol';

/**
 * Single named boundary for PTY-only operations. A Chat Terminal has no PTY, so input bytes, resize, snapshots,
 * suspension, restore, dispatch, and compaction reject it here before any side effect instead of failing later inside
 * Terminal Host. See `docs/adr/0012-agent-chat-surface.md`.
 */
export function assertPtyTerminal(terminal: { surface?: TerminalSurface } | undefined): void {
    if (terminal && isChatTerminal(terminal))
        throw new CaxriError(
            'UNAVAILABLE',
            'This action needs a terminal; this Agent runs as a Chat',
        );
}

/**
 * Filter predicate for background sweeps (restore, suspension, resource sampling) that must skip Chat Terminals.
 */
export function isPtyTerminal(terminal: { surface?: TerminalSurface }): boolean {
    return !isChatTerminal(terminal);
}
