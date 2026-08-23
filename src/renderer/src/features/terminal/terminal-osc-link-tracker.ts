import {
    MAX_TERMINAL_LINK_LENGTH,
    MAX_TERMINAL_OSC_LINK_CELLS,
    MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS,
    MAX_TERMINAL_OSC_LINKS,
} from '@shared/ipc';
import {
    areTerminalOscLinkRangesOverlapping,
    terminalOscLinkCellSpan,
    terminalOscLinkFingerprint,
    terminalOscLinkFingerprintCellCount,
} from '@shared/terminal-osc-link-fingerprint';
import type { TerminalOscLinkSnapshot } from '@shared/types';
import type { IBuffer, IMarker, Terminal } from '@xterm/xterm';

import type { TerminalLinkMatch } from './terminal-links';

export { MAX_TERMINAL_LINK_LENGTH, MAX_TERMINAL_LINK_ROWS } from '@shared/ipc';

interface OscLinkPosition {
    column: number;
    marker: IMarker;
}

interface PendingOscLink {
    buffer: IBuffer;
    match: TerminalLinkMatch;
    start: OscLinkPosition;
}

interface TrackedOscLink extends PendingOscLink {
    cellCount: number;
    end: OscLinkPosition;
    fingerprint: string;
}

interface VisibleOscLink {
    bufferLine: number;
    id: string;
    match: TerminalLinkMatch;
}

interface TerminalOscLinkTracker {
    dispose(): void;
    getViewportLinks(): VisibleOscLink[];
    restoreOscLinks(snapshots: readonly TerminalOscLinkSnapshot[]): void;
}

/**
 * Produces a content-free, bounded fingerprint for the public buffer cells covered by an OSC 8 label. It lets the
 * picker reject overwritten labels without retaining Terminal output or relying on xterm's private link internals.
 */
function oscLinkFingerprint(
    terminal: Terminal,
    buffer: IBuffer,
    start: OscLinkPosition,
    end: OscLinkPosition,
): string | undefined {
    if (start.marker.isDisposed || end.marker.isDisposed) return;
    return terminalOscLinkFingerprint(
        terminal.cols,
        buffer,
        { column: start.column, line: start.marker.line },
        { column: end.column, line: end.marker.line },
    );
}

/**
 * Observes xterm's public OSC parser and marker APIs. The active buffer is part of each record's identity: alternate
 * screen transitions hide links from the inactive buffer without validating against, or deleting from, the wrong one.
 */
export function registerTerminalOscLinkTracker(
    terminal: Terminal,
    matchTarget: (target: string) => TerminalLinkMatch | undefined,
): TerminalOscLinkTracker {
    const trackedOscLinks = new Map<number, TrackedOscLink>();
    let retainedCellCount = 0;
    let retainedTargetCharacters = 0;
    let pendingOscLink: PendingOscLink | undefined;
    const removeOscLink = (id: number): void => {
        const tracked = trackedOscLinks.get(id);
        if (!tracked) return;
        trackedOscLinks.delete(id);
        retainedCellCount -= tracked.cellCount;
        retainedTargetCharacters -= tracked.match.target.length;
        if (!tracked.start.marker.isDisposed) tracked.start.marker.dispose();
        if (!tracked.end.marker.isDisposed) tracked.end.marker.dispose();
    };
    const retainOscLink = (tracked: TrackedOscLink): void => {
        for (const existing of trackedOscLinks.values()) {
            if (existing.buffer !== tracked.buffer) continue;
            if (
                areTerminalOscLinkRangesOverlapping(
                    {
                        end: { column: existing.end.column, line: existing.end.marker.line },
                        start: {
                            column: existing.start.column,
                            line: existing.start.marker.line,
                        },
                    },
                    {
                        end: { column: tracked.end.column, line: tracked.end.marker.line },
                        start: {
                            column: tracked.start.column,
                            line: tracked.start.marker.line,
                        },
                    },
                )
            )
                removeOscLink(existing.start.marker.id);
        }
        while (
            trackedOscLinks.size >= MAX_TERMINAL_OSC_LINKS ||
            retainedCellCount + tracked.cellCount > MAX_TERMINAL_OSC_LINK_CELLS ||
            retainedTargetCharacters + tracked.match.target.length >
                MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS
        ) {
            const oldestId = trackedOscLinks.keys().next().value;
            if (oldestId === undefined) break;
            removeOscLink(oldestId);
        }
        trackedOscLinks.set(tracked.start.marker.id, tracked);
        retainedCellCount += tracked.cellCount;
        retainedTargetCharacters += tracked.match.target.length;
        const remove = () => removeOscLink(tracked.start.marker.id);
        tracked.start.marker.onDispose(remove);
        tracked.end.marker.onDispose(remove);
    };
    const finishPendingOscLink = (): void => {
        const pending = pendingOscLink;
        pendingOscLink = undefined;
        if (!pending) return;
        if (pending.buffer !== terminal.buffer.active) {
            pending.start.marker.dispose();
            return;
        }
        const end: OscLinkPosition = {
            column: pending.buffer.cursorX,
            marker: terminal.registerMarker(),
        };
        const fingerprint = oscLinkFingerprint(terminal, pending.buffer, pending.start, end);
        if (!fingerprint) {
            pending.start.marker.dispose();
            end.marker.dispose();
            return;
        }
        retainOscLink({
            ...pending,
            cellCount: terminalOscLinkFingerprintCellCount(fingerprint),
            end,
            fingerprint,
        });
    };
    const parserDisposable = terminal.parser.registerOscHandler(8, (data) => {
        finishPendingOscLink();
        const separator = data.indexOf(';');
        const target = separator === -1 ? '' : data.slice(separator + 1);
        const match =
            target && target.length <= MAX_TERMINAL_LINK_LENGTH ? matchTarget(target) : undefined;
        if (match) {
            pendingOscLink = {
                buffer: terminal.buffer.active,
                match,
                start: {
                    column: terminal.buffer.active.cursorX,
                    marker: terminal.registerMarker(),
                },
            };
        }
        return false;
    });
    const restoreOscLinks = (snapshots: readonly TerminalOscLinkSnapshot[]): void => {
        for (const id of trackedOscLinks.keys()) removeOscLink(id);
        const activeBuffer = terminal.buffer.active;
        const cursorLine = activeBuffer.baseY + activeBuffer.cursorY;
        let restoredCells = 0;
        let restoredTargetCharacters = 0;
        for (const snapshot of snapshots) {
            const startPosition = {
                column: snapshot.startColumn,
                line: cursorLine + snapshot.startCursorOffset,
            };
            const endPosition = {
                column: snapshot.endColumn,
                line: cursorLine + snapshot.endCursorOffset,
            };
            const cellSpan = terminalOscLinkCellSpan(terminal.cols, startPosition, endPosition);
            if (
                cellSpan === undefined ||
                restoredCells + cellSpan > MAX_TERMINAL_OSC_LINK_CELLS ||
                restoredTargetCharacters + snapshot.target.length >
                    MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS
            )
                continue;
            const match = matchTarget(snapshot.target);
            if (!match) continue;
            const startMarker = terminal.registerMarker(snapshot.startCursorOffset);
            const endMarker = terminal.registerMarker(snapshot.endCursorOffset);
            const start = { column: snapshot.startColumn, marker: startMarker };
            const end = { column: snapshot.endColumn, marker: endMarker };
            const fingerprint = oscLinkFingerprint(terminal, activeBuffer, start, end);
            if (!fingerprint) {
                startMarker.dispose();
                endMarker.dispose();
                continue;
            }
            restoredCells += cellSpan;
            restoredTargetCharacters += snapshot.target.length;
            retainOscLink({
                buffer: activeBuffer,
                cellCount: terminalOscLinkFingerprintCellCount(fingerprint),
                end,
                fingerprint,
                match,
                start,
            });
        }
    };
    return {
        getViewportLinks() {
            const activeBuffer = terminal.buffer.active;
            const firstVisibleLine = activeBuffer.viewportY;
            const lastVisibleLine = firstVisibleLine + terminal.rows - 1;
            const links: VisibleOscLink[] = [];
            for (const link of trackedOscLinks.values()) {
                const { buffer, end, fingerprint, match, start } = link;
                if (buffer !== activeBuffer) continue;
                const currentFingerprint = oscLinkFingerprint(terminal, buffer, start, end);
                if (!currentFingerprint || currentFingerprint !== fingerprint) {
                    removeOscLink(start.marker.id);
                    continue;
                }
                if (end.marker.line < firstVisibleLine || start.marker.line > lastVisibleLine)
                    continue;
                links.push({
                    bufferLine: start.marker.line,
                    id: `osc:${start.marker.id}:${match.text}`,
                    match,
                });
            }
            return links;
        },
        restoreOscLinks,
        dispose() {
            parserDisposable.dispose();
            pendingOscLink?.start.marker.dispose();
            pendingOscLink = undefined;
            for (const id of trackedOscLinks.keys()) removeOscLink(id);
        },
    };
}
