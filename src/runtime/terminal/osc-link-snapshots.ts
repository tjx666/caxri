import type { TerminalOscLinkSnapshot } from '@caxri/protocol';
import {
    MAX_TERMINAL_LINK_LENGTH,
    MAX_TERMINAL_OSC_LINK_CELLS,
    MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS,
    MAX_TERMINAL_OSC_LINKS,
} from '@caxri/protocol';
import type { IBuffer, IMarker, Terminal } from '@xterm/headless';

import {
    areTerminalOscLinkRangesOverlapping,
    resolveTerminalOscLinkCellOffset,
    terminalOscLinkCellAnchor,
    terminalOscLinkFingerprint,
    terminalOscLinkFingerprintCellCount,
    terminalOscLinkLogicalPosition,
} from '../../shared/terminal-osc-link-fingerprint';

interface OscLinkPosition {
    cellOffset: number;
    marker: IMarker;
}

interface PendingOscLink {
    buffer: IBuffer;
    start: OscLinkPosition;
    target: string;
}

interface TrackedOscLink extends PendingOscLink {
    cellCount: number;
    end: OscLinkPosition;
    fingerprint: string;
}

function currentRange(
    columns: number,
    tracked: Pick<TrackedOscLink, 'buffer' | 'end' | 'start'>,
): { end: { column: number; line: number }; start: { column: number; line: number } } | undefined {
    const start = resolveTerminalOscLinkCellOffset(
        tracked.buffer,
        columns,
        tracked.start.marker.line,
        tracked.start.cellOffset,
    );
    const end = resolveTerminalOscLinkCellOffset(
        tracked.buffer,
        columns,
        tracked.end.marker.line,
        tracked.end.cellOffset,
    );
    if (!start || !end) return;
    return { end, start };
}

function areRangesOverlapping(
    columns: number,
    left: TrackedOscLink,
    right: TrackedOscLink,
): boolean {
    const leftRange = currentRange(columns, left);
    const rightRange = currentRange(columns, right);
    return (
        left.buffer === right.buffer &&
        leftRange !== undefined &&
        rightRange !== undefined &&
        areTerminalOscLinkRangesOverlapping(leftRange, rightRange)
    );
}

/**
 * Tracks OSC 8 identities beside Runtime's authoritative parsed screen. xterm's serializer retains label cells but not
 * their URI metadata, so attach snapshots carry this separately and never depend on a detached Renderer's stale state.
 */
export class TerminalOscLinkSnapshots {
    private cellCount = 0;
    private readonly parserDisposable;
    private pending?: PendingOscLink;
    private readonly tracked = new Map<number, TrackedOscLink>();
    private targetCharacters = 0;

    constructor(private readonly terminal: Terminal) {
        this.parserDisposable = terminal.parser.registerOscHandler(8, (data) => {
            this.finishPending();
            const separator = data.indexOf(';');
            const target = separator === -1 ? '' : data.slice(separator + 1);
            if (target && target.length <= MAX_TERMINAL_LINK_LENGTH) {
                const buffer = terminal.buffer.active;
                const column = buffer.cursorX;
                const cursorLine = buffer.baseY + buffer.cursorY;
                const anchor = terminalOscLinkCellAnchor(buffer, terminal.cols, {
                    column,
                    line: cursorLine,
                });
                if (!anchor) return false;
                const marker = terminal.registerMarker(anchor.line - cursorLine);
                this.pending = {
                    buffer,
                    start: {
                        cellOffset: anchor.cellOffset,
                        marker,
                    },
                    target,
                };
            }
            return false;
        });
    }

    private finishPending(): void {
        const pending = this.pending;
        this.pending = undefined;
        if (!pending) return;
        if (pending.buffer !== this.terminal.buffer.active) {
            pending.start.marker.dispose();
            return;
        }
        const endColumn = pending.buffer.cursorX;
        const cursorLine = pending.buffer.baseY + pending.buffer.cursorY;
        const endAnchor = terminalOscLinkCellAnchor(pending.buffer, this.terminal.cols, {
            column: endColumn,
            line: cursorLine,
        });
        if (!endAnchor) {
            pending.start.marker.dispose();
            return;
        }
        const endMarker = this.terminal.registerMarker(endAnchor.line - cursorLine);
        const end: OscLinkPosition = {
            cellOffset: endAnchor.cellOffset,
            marker: endMarker,
        };
        const tracked = {
            ...pending,
            end,
        };
        const range = currentRange(this.terminal.cols, tracked);
        if (!range) {
            pending.start.marker.dispose();
            end.marker.dispose();
            return;
        }
        const fingerprint = terminalOscLinkFingerprint(
            this.terminal.cols,
            pending.buffer,
            range.start,
            range.end,
        );
        if (!fingerprint) {
            pending.start.marker.dispose();
            end.marker.dispose();
            return;
        }
        const completed = {
            ...pending,
            cellCount: terminalOscLinkFingerprintCellCount(fingerprint),
            end,
            fingerprint,
        };
        for (const existing of this.tracked.values())
            if (areRangesOverlapping(this.terminal.cols, existing, completed))
                this.remove(existing.start.marker.id);
        while (
            this.tracked.size >= MAX_TERMINAL_OSC_LINKS ||
            this.cellCount + completed.cellCount > MAX_TERMINAL_OSC_LINK_CELLS ||
            this.targetCharacters + completed.target.length >
                MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS
        ) {
            const oldestId = this.tracked.keys().next().value;
            if (oldestId === undefined) break;
            this.remove(oldestId);
        }
        this.tracked.set(pending.start.marker.id, completed);
        this.cellCount += completed.cellCount;
        this.targetCharacters += completed.target.length;
        const remove = () => this.remove(pending.start.marker.id);
        pending.start.marker.onDispose(remove);
        end.marker.onDispose(remove);
    }

    private remove(id: number): void {
        const tracked = this.tracked.get(id);
        if (!tracked) return;
        this.tracked.delete(id);
        this.cellCount -= tracked.cellCount;
        this.targetCharacters -= tracked.target.length;
        if (!tracked.start.marker.isDisposed) tracked.start.marker.dispose();
        if (!tracked.end.marker.isDisposed) tracked.end.marker.dispose();
    }

    snapshot(normalBufferStartLine = 0): TerminalOscLinkSnapshot[] {
        const activeBuffer = this.terminal.buffer.active;
        const normalBuffer = this.terminal.buffer.normal;
        const terminalColumns = this.terminal.cols;
        const snapshots: TerminalOscLinkSnapshot[] = [];
        for (const tracked of this.tracked.values()) {
            const buffer =
                tracked.buffer === normalBuffer
                    ? 'normal'
                    : tracked.buffer === activeBuffer && activeBuffer.type === 'alternate'
                      ? 'alternate'
                      : undefined;
            if (!buffer) continue;
            const range = currentRange(terminalColumns, tracked);
            if (!range) {
                this.remove(tracked.start.marker.id);
                continue;
            }
            const minimumLine = buffer === 'normal' ? normalBufferStartLine : 0;
            const start = terminalOscLinkLogicalPosition(
                tracked.buffer,
                terminalColumns,
                range.start,
                minimumLine,
            );
            const end = terminalOscLinkLogicalPosition(
                tracked.buffer,
                terminalColumns,
                range.end,
                minimumLine,
            );
            if (!start || !end) continue;
            const fingerprint = terminalOscLinkFingerprint(
                terminalColumns,
                tracked.buffer,
                range.start,
                range.end,
            );
            if (fingerprint !== tracked.fingerprint) {
                this.remove(tracked.start.marker.id);
                continue;
            }
            snapshots.push({
                buffer,
                endCellOffset: end.cellOffset,
                /**
                 * SerializeAddon can restore an inactive normal buffer with a different cursor row, and xterm can
                 * reflow it again before activation. Dual-ended logical wrapped-line coordinates preserve the label
                 * identity across cursor drift, trailing viewport changes, and bounded scrollback trims without
                 * retaining Terminal output.
                 */
                endLogicalLineIndex: end.logicalLineIndex,
                endLogicalLineOffset: end.logicalLineOffset,
                fingerprint,
                startCellOffset: start.cellOffset,
                startLogicalLineIndex: start.logicalLineIndex,
                startLogicalLineOffset: start.logicalLineOffset,
                target: tracked.target,
            });
        }
        return snapshots;
    }

    dispose(): void {
        this.parserDisposable.dispose();
        this.pending?.start.marker.dispose();
        this.pending = undefined;
        for (const id of this.tracked.keys()) this.remove(id);
    }
}
