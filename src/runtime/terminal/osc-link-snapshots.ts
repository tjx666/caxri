import type { IBuffer, IMarker, Terminal } from '@xterm/headless';

import {
    MAX_TERMINAL_LINK_LENGTH,
    MAX_TERMINAL_OSC_LINK_CELLS,
    MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS,
    MAX_TERMINAL_OSC_LINKS,
} from '../../shared/ipc';
import {
    areTerminalOscLinkRangesOverlapping,
    terminalOscLinkFingerprint,
    terminalOscLinkFingerprintCellCount,
} from '../../shared/terminal-osc-link-fingerprint';
import type { TerminalOscLinkSnapshot } from '../../shared/types';

interface OscLinkPosition {
    column: number;
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

function areRangesOverlapping(left: TrackedOscLink, right: TrackedOscLink): boolean {
    return (
        left.buffer === right.buffer &&
        areTerminalOscLinkRangesOverlapping(
            {
                end: { column: left.end.column, line: left.end.marker.line },
                start: { column: left.start.column, line: left.start.marker.line },
            },
            {
                end: { column: right.end.column, line: right.end.marker.line },
                start: { column: right.start.column, line: right.start.marker.line },
            },
        )
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
                this.pending = {
                    buffer: terminal.buffer.active,
                    start: {
                        column: terminal.buffer.active.cursorX,
                        marker: terminal.registerMarker(),
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
        const end: OscLinkPosition = {
            column: pending.buffer.cursorX,
            marker: this.terminal.registerMarker(),
        };
        const fingerprint = terminalOscLinkFingerprint(
            this.terminal.cols,
            pending.buffer,
            { column: pending.start.column, line: pending.start.marker.line },
            { column: end.column, line: end.marker.line },
        );
        if (!fingerprint) {
            pending.start.marker.dispose();
            end.marker.dispose();
            return;
        }
        const tracked = {
            ...pending,
            cellCount: terminalOscLinkFingerprintCellCount(fingerprint),
            end,
            fingerprint,
        };
        for (const existing of this.tracked.values())
            if (areRangesOverlapping(existing, tracked)) this.remove(existing.start.marker.id);
        while (
            this.tracked.size >= MAX_TERMINAL_OSC_LINKS ||
            this.cellCount + tracked.cellCount > MAX_TERMINAL_OSC_LINK_CELLS ||
            this.targetCharacters + tracked.target.length > MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS
        ) {
            const oldestId = this.tracked.keys().next().value;
            if (oldestId === undefined) break;
            this.remove(oldestId);
        }
        this.tracked.set(pending.start.marker.id, tracked);
        this.cellCount += tracked.cellCount;
        this.targetCharacters += tracked.target.length;
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

    snapshot(): TerminalOscLinkSnapshot[] {
        const activeBuffer = this.terminal.buffer.active;
        const cursorLine = activeBuffer.baseY + activeBuffer.cursorY;
        const snapshots: TerminalOscLinkSnapshot[] = [];
        for (const tracked of this.tracked.values()) {
            if (tracked.buffer !== activeBuffer) continue;
            const fingerprint = terminalOscLinkFingerprint(
                this.terminal.cols,
                tracked.buffer,
                { column: tracked.start.column, line: tracked.start.marker.line },
                { column: tracked.end.column, line: tracked.end.marker.line },
            );
            if (fingerprint !== tracked.fingerprint) {
                this.remove(tracked.start.marker.id);
                continue;
            }
            snapshots.push({
                endColumn: tracked.end.column,
                endCursorOffset: tracked.end.marker.line - cursorLine,
                startColumn: tracked.start.column,
                startCursorOffset: tracked.start.marker.line - cursorLine,
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
