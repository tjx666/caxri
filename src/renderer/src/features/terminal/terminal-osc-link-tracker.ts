import type { IBuffer, IMarker, Terminal } from '@xterm/xterm';

import type { TerminalLinkMatch } from './terminal-links';

export const MAX_TERMINAL_LINK_ROWS = 16;
export const MAX_TERMINAL_LINK_LENGTH = 16_384;
const MAX_RETAINED_OSC_LINKS = 1_000;
const persistedOscLinks = new Map<string, OscLinkSnapshot[]>();

type BufferType = 'alternate' | 'normal';

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
    end: OscLinkPosition;
    fingerprint: string;
}

interface OscLinkSnapshot {
    bufferType: BufferType;
    endColumn: number;
    endCursorOffset: number;
    fingerprint: string;
    match: TerminalLinkMatch;
    startColumn: number;
    startCursorOffset: number;
}

interface VisibleOscLink {
    bufferLine: number;
    id: string;
    match: TerminalLinkMatch;
}

interface TerminalOscLinkTracker {
    dispose(): void;
    getViewportLinks(): VisibleOscLink[];
}

/**
 * A closed Terminal must not leave hidden OSC targets in Renderer memory. Inactive pane remounts reuse the same id,
 * while a real close clears the bounded persistence entry after Main confirms the Terminal was removed.
 */
export function clearTerminalOscLinkSnapshots(terminalId: string): void {
    persistedOscLinks.delete(terminalId);
}

function saveTerminalOscLinkSnapshots(terminalId: string, snapshots: OscLinkSnapshot[]): void {
    persistedOscLinks.delete(terminalId);
    if (snapshots.length === 0) return;
    const retained = snapshots.slice(-MAX_RETAINED_OSC_LINKS);
    let retainedCount = 0;
    for (const links of persistedOscLinks.values()) retainedCount += links.length;
    while (retainedCount + retained.length > MAX_RETAINED_OSC_LINKS) {
        const oldestTerminalId = persistedOscLinks.keys().next().value;
        if (oldestTerminalId === undefined) break;
        retainedCount -= persistedOscLinks.get(oldestTerminalId)?.length ?? 0;
        persistedOscLinks.delete(oldestTerminalId);
    }
    persistedOscLinks.set(terminalId, retained);
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
    const startLine = start.marker.line;
    const endLine = end.marker.line;
    if (
        startLine < 0 ||
        endLine < startLine ||
        (endLine === startLine && end.column <= start.column) ||
        endLine - startLine + 1 > MAX_TERMINAL_LINK_ROWS
    )
        return;
    let cellCount = 0;
    let hash = 2_166_136_261;
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
        const line = buffer.getLine(lineNumber);
        if (!line) return;
        const firstColumn = lineNumber === startLine ? start.column : 0;
        const lastColumn =
            lineNumber === endLine ? end.column : Math.min(line.length, terminal.cols);
        if (lastColumn < firstColumn) return;
        cellCount += lastColumn - firstColumn;
        if (cellCount > MAX_TERMINAL_LINK_LENGTH) return;
        const text = line.translateToString(false, firstColumn, lastColumn);
        for (const character of text) {
            hash ^= character.codePointAt(0) ?? 0;
            hash = Math.imul(hash, 16_777_619);
        }
        hash ^= 10;
        hash = Math.imul(hash, 16_777_619);
    }
    return `${cellCount}:${hash >>> 0}`;
}

/**
 * Observes xterm's public OSC parser and marker APIs. The active buffer is part of each record's identity: alternate
 * screen transitions hide links from the inactive buffer without validating against, or deleting from, the wrong one.
 */
export function registerTerminalOscLinkTracker(
    terminal: Terminal,
    matchTarget: (target: string) => TerminalLinkMatch | undefined,
    persistenceKey?: string,
): TerminalOscLinkTracker {
    const trackedOscLinks = new Map<number, TrackedOscLink>();
    let pendingSnapshots = persistenceKey ? (persistedOscLinks.get(persistenceKey) ?? []) : [];
    if (persistenceKey) persistedOscLinks.delete(persistenceKey);
    let pendingOscLink: PendingOscLink | undefined;
    const removeOscLink = (id: number): void => {
        const tracked = trackedOscLinks.get(id);
        if (!tracked) return;
        trackedOscLinks.delete(id);
        if (!tracked.start.marker.isDisposed) tracked.start.marker.dispose();
        if (!tracked.end.marker.isDisposed) tracked.end.marker.dispose();
    };
    const retainOscLink = (tracked: TrackedOscLink): void => {
        while (trackedOscLinks.size >= MAX_RETAINED_OSC_LINKS) {
            const oldestId = trackedOscLinks.keys().next().value;
            if (oldestId === undefined) break;
            removeOscLink(oldestId);
        }
        trackedOscLinks.set(tracked.start.marker.id, tracked);
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
        retainOscLink({ ...pending, end, fingerprint });
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
    const bufferType = (buffer: IBuffer): BufferType =>
        buffer === terminal.buffer.normal ? 'normal' : 'alternate';
    const restoreActiveBufferSnapshots = (): void => {
        if (pendingSnapshots.length === 0) return;
        const activeBuffer = terminal.buffer.active;
        const activeBufferType = bufferType(activeBuffer);
        const remaining: OscLinkSnapshot[] = [];
        for (const snapshot of pendingSnapshots) {
            if (snapshot.bufferType !== activeBufferType) {
                remaining.push(snapshot);
                continue;
            }
            const match = matchTarget(snapshot.match.target);
            if (!match) continue;
            const startMarker = terminal.registerMarker(snapshot.startCursorOffset);
            const endMarker = terminal.registerMarker(snapshot.endCursorOffset);
            const start = { column: snapshot.startColumn, marker: startMarker };
            const end = { column: snapshot.endColumn, marker: endMarker };
            const fingerprint = oscLinkFingerprint(terminal, activeBuffer, start, end);
            if (fingerprint !== snapshot.fingerprint) {
                startMarker.dispose();
                endMarker.dispose();
                continue;
            }
            retainOscLink({ buffer: activeBuffer, end, fingerprint, match, start });
        }
        pendingSnapshots = remaining;
    };
    const createSnapshots = (): OscLinkSnapshot[] => {
        const snapshots = [...pendingSnapshots];
        for (const { buffer, end, fingerprint, match, start } of trackedOscLinks.values()) {
            const currentFingerprint = oscLinkFingerprint(terminal, buffer, start, end);
            if (currentFingerprint !== fingerprint) continue;
            const cursorLine = buffer.baseY + buffer.cursorY;
            snapshots.push({
                bufferType: bufferType(buffer),
                endColumn: end.column,
                endCursorOffset: end.marker.line - cursorLine,
                fingerprint,
                match,
                startColumn: start.column,
                startCursorOffset: start.marker.line - cursorLine,
            });
        }
        return snapshots.slice(-MAX_RETAINED_OSC_LINKS);
    };
    return {
        getViewportLinks() {
            /**
             * Runtime screen replay finishes after link registration. Recreate xterm markers lazily against the
             * populated public buffer, then let their offsets track future scrolling exactly like live OSC markers.
             */
            restoreActiveBufferSnapshots();
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
        dispose() {
            if (persistenceKey) saveTerminalOscLinkSnapshots(persistenceKey, createSnapshots());
            parserDisposable.dispose();
            pendingOscLink?.start.marker.dispose();
            pendingOscLink = undefined;
            for (const id of trackedOscLinks.keys()) removeOscLink(id);
        },
    };
}
