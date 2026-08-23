import {
    MAX_TERMINAL_LINK_LENGTH,
    MAX_TERMINAL_OSC_LINK_CELLS,
    MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS,
    MAX_TERMINAL_OSC_LINKS,
} from '@shared/ipc';
import {
    areTerminalOscLinkRangesOverlapping,
    resolveTerminalOscLinkCellOffset,
    resolveTerminalOscLinkLogicalPosition,
    terminalOscLinkCellAnchor,
    terminalOscLinkFingerprint,
    terminalOscLinkFingerprintCellCount,
} from '@shared/terminal-osc-link-fingerprint';
import type { TerminalOscLinkSnapshot } from '@shared/types';
import type { IBuffer, IMarker, Terminal } from '@xterm/xterm';

import type { TerminalLinkMatch } from './terminal-links';

export { MAX_TERMINAL_LINK_LENGTH, MAX_TERMINAL_LINK_ROWS } from '@shared/ipc';

interface OscLinkPosition {
    cellOffset: number;
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
    const range = oscLinkRange(terminal, buffer, start, end);
    if (!range) return;
    return terminalOscLinkFingerprint(terminal.cols, buffer, range.start, range.end);
}

function oscLinkRange(
    terminal: Terminal,
    buffer: IBuffer,
    start: OscLinkPosition,
    end: OscLinkPosition,
) {
    if (start.marker.isDisposed || end.marker.isDisposed) return;
    const startPosition = resolveTerminalOscLinkCellOffset(
        buffer,
        terminal.cols,
        start.marker.line,
        start.cellOffset,
    );
    const endPosition = resolveTerminalOscLinkCellOffset(
        buffer,
        terminal.cols,
        end.marker.line,
        end.cellOffset,
    );
    if (!startPosition || !endPosition) return;
    return { end: endPosition, start: startPosition };
}

function resolveOscLinkSnapshot(
    terminal: Terminal,
    buffer: IBuffer,
    snapshot: TerminalOscLinkSnapshot,
) {
    for (const anchor of ['start', 'end'] as const) {
        const start = resolveTerminalOscLinkLogicalPosition(
            buffer,
            terminal.cols,
            {
                cellOffset: snapshot.startCellOffset,
                logicalLineIndex: snapshot.startLogicalLineIndex,
                logicalLineOffset: snapshot.startLogicalLineOffset,
            },
            anchor,
        );
        const end = resolveTerminalOscLinkLogicalPosition(
            buffer,
            terminal.cols,
            {
                cellOffset: snapshot.endCellOffset,
                logicalLineIndex: snapshot.endLogicalLineIndex,
                logicalLineOffset: snapshot.endLogicalLineOffset,
            },
            anchor,
        );
        if (!start || !end) continue;
        const fingerprint = terminalOscLinkFingerprint(terminal.cols, buffer, start, end);
        if (fingerprint === snapshot.fingerprint) return { end, fingerprint, start };
    }
    return;
}

/**
 * Observes xterm's public OSC parser and marker APIs. The active buffer is part of each record's identity: alternate
 * screen transitions hide links from the inactive buffer without validating against, or deleting from, the wrong one.
 */
export function registerTerminalOscLinkTracker(
    terminal: Terminal,
    matchTarget: (target: string) => TerminalLinkMatch | undefined,
): TerminalOscLinkTracker {
    const pendingRestorations = new Map<
        TerminalOscLinkSnapshot['buffer'],
        TerminalOscLinkSnapshot[]
    >();
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
        const trackedRange = oscLinkRange(terminal, tracked.buffer, tracked.start, tracked.end);
        if (!trackedRange) {
            tracked.start.marker.dispose();
            tracked.end.marker.dispose();
            return;
        }
        for (const existing of trackedOscLinks.values()) {
            if (existing.buffer !== tracked.buffer) continue;
            const existingRange = oscLinkRange(
                terminal,
                existing.buffer,
                existing.start,
                existing.end,
            );
            if (!existingRange) {
                removeOscLink(existing.start.marker.id);
                continue;
            }
            if (areTerminalOscLinkRangesOverlapping(existingRange, trackedRange))
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
        const endColumn = pending.buffer.cursorX;
        const cursorLine = pending.buffer.baseY + pending.buffer.cursorY;
        const endAnchor = terminalOscLinkCellAnchor(pending.buffer, terminal.cols, {
            column: endColumn,
            line: cursorLine,
        });
        if (!endAnchor) {
            pending.start.marker.dispose();
            return;
        }
        const endMarker = terminal.registerMarker(endAnchor.line - cursorLine);
        const end: OscLinkPosition = {
            cellOffset: endAnchor.cellOffset,
            marker: endMarker,
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
            const buffer = terminal.buffer.active;
            const column = buffer.cursorX;
            const cursorLine = buffer.baseY + buffer.cursorY;
            const anchor = terminalOscLinkCellAnchor(buffer, terminal.cols, {
                column,
                line: cursorLine,
            });
            if (!anchor) return false;
            const marker = terminal.registerMarker(anchor.line - cursorLine);
            pendingOscLink = {
                buffer,
                match,
                start: {
                    cellOffset: anchor.cellOffset,
                    marker,
                },
            };
        }
        return false;
    });
    const restoreBufferSnapshots = (activeBuffer: IBuffer): void => {
        const buffer =
            activeBuffer === terminal.buffer.normal
                ? 'normal'
                : activeBuffer === terminal.buffer.alternate
                  ? 'alternate'
                  : undefined;
        if (!buffer) return;
        const snapshots = pendingRestorations.get(buffer);
        if (!snapshots) return;
        pendingRestorations.delete(buffer);
        for (const snapshot of snapshots) {
            const match = matchTarget(snapshot.target);
            if (!match) continue;
            const resolved = resolveOscLinkSnapshot(terminal, activeBuffer, snapshot);
            if (!resolved) continue;
            const { end: endPosition, start: startPosition } = resolved;
            const cursorLine = activeBuffer.baseY + activeBuffer.cursorY;
            const startAnchor = terminalOscLinkCellAnchor(
                activeBuffer,
                terminal.cols,
                startPosition,
            );
            const endAnchor = terminalOscLinkCellAnchor(activeBuffer, terminal.cols, endPosition);
            if (!startAnchor || !endAnchor) continue;
            const startMarker = terminal.registerMarker(startAnchor.line - cursorLine);
            const endMarker = terminal.registerMarker(endAnchor.line - cursorLine);
            const start = {
                cellOffset: snapshot.startCellOffset,
                marker: startMarker,
            };
            const end = {
                cellOffset: snapshot.endCellOffset,
                marker: endMarker,
            };
            const fingerprint = oscLinkFingerprint(terminal, activeBuffer, start, end);
            if (fingerprint !== snapshot.fingerprint) {
                startMarker.dispose();
                endMarker.dispose();
                continue;
            }
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
    const restoreOscLinks = (snapshots: readonly TerminalOscLinkSnapshot[]): void => {
        for (const id of trackedOscLinks.keys()) removeOscLink(id);
        pendingRestorations.clear();
        let restoredCells = 0;
        let restoredTargetCharacters = 0;
        for (const snapshot of snapshots) {
            const snapshotBuffer =
                snapshot.buffer === 'normal' ? terminal.buffer.normal : terminal.buffer.alternate;
            /**
             * Resolve and verify the logical coordinate now, but retain it for a second resolution when an inactive
             * buffer becomes active. xterm can reflow the hidden normal buffer between those points; physical rows and
             * cursor offsets cannot represent that lifecycle safely.
             */
            const resolved = resolveOscLinkSnapshot(terminal, snapshotBuffer, snapshot);
            if (!resolved) continue;
            const { fingerprint } = resolved;
            const cellSpan = terminalOscLinkFingerprintCellCount(snapshot.fingerprint);
            if (
                fingerprint !== snapshot.fingerprint ||
                restoredCells + cellSpan > MAX_TERMINAL_OSC_LINK_CELLS ||
                restoredTargetCharacters + snapshot.target.length >
                    MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS
            )
                continue;
            restoredCells += cellSpan;
            restoredTargetCharacters += snapshot.target.length;
            const pending = pendingRestorations.get(snapshot.buffer) ?? [];
            pending.push(snapshot);
            pendingRestorations.set(snapshot.buffer, pending);
        }
        restoreBufferSnapshots(terminal.buffer.active);
    };
    const bufferChangeDisposable = terminal.buffer.onBufferChange(restoreBufferSnapshots);
    return {
        getViewportLinks() {
            const activeBuffer = terminal.buffer.active;
            const firstVisibleLine = activeBuffer.viewportY;
            const lastVisibleLine = firstVisibleLine + terminal.rows - 1;
            const links: VisibleOscLink[] = [];
            for (const link of trackedOscLinks.values()) {
                const { buffer, end, fingerprint, match, start } = link;
                if (buffer !== activeBuffer) continue;
                const startMarkerId = start.marker.id;
                const range = oscLinkRange(terminal, buffer, start, end);
                if (!range) {
                    removeOscLink(startMarkerId);
                    continue;
                }
                const currentFingerprint = oscLinkFingerprint(terminal, buffer, start, end);
                if (!currentFingerprint || currentFingerprint !== fingerprint) {
                    removeOscLink(startMarkerId);
                    continue;
                }
                if (range.end.line < firstVisibleLine || range.start.line > lastVisibleLine)
                    continue;
                links.push({
                    bufferLine: range.start.line,
                    id: `osc:${startMarkerId}:${match.text}`,
                    match,
                });
            }
            return links;
        },
        restoreOscLinks,
        dispose() {
            bufferChangeDisposable.dispose();
            parserDisposable.dispose();
            pendingOscLink?.start.marker.dispose();
            pendingOscLink = undefined;
            pendingRestorations.clear();
            for (const id of trackedOscLinks.keys()) removeOscLink(id);
        },
    };
}
