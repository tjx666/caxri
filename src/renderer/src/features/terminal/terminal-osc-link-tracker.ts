import type { IBuffer, IMarker, Terminal } from '@xterm/xterm';

import type { TerminalLinkMatch } from './terminal-links';

export const MAX_TERMINAL_LINK_ROWS = 16;
export const MAX_TERMINAL_LINK_LENGTH = 16_384;
const MAX_RETAINED_OSC_LINKS = 1_000;

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
): TerminalOscLinkTracker {
    const trackedOscLinks = new Map<number, TrackedOscLink>();
    let pendingOscLink: PendingOscLink | undefined;
    const removeOscLink = (id: number): void => {
        const tracked = trackedOscLinks.get(id);
        if (!tracked) return;
        trackedOscLinks.delete(id);
        if (!tracked.start.marker.isDisposed) tracked.start.marker.dispose();
        if (!tracked.end.marker.isDisposed) tracked.end.marker.dispose();
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
        while (trackedOscLinks.size >= MAX_RETAINED_OSC_LINKS) {
            const oldestId = trackedOscLinks.keys().next().value;
            if (oldestId === undefined) break;
            removeOscLink(oldestId);
        }
        const tracked = { ...pending, end, fingerprint };
        trackedOscLinks.set(pending.start.marker.id, tracked);
        const remove = () => removeOscLink(pending.start.marker.id);
        pending.start.marker.onDispose(remove);
        end.marker.onDispose(remove);
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
        dispose() {
            parserDisposable.dispose();
            pendingOscLink?.start.marker.dispose();
            pendingOscLink = undefined;
            for (const id of trackedOscLinks.keys()) removeOscLink(id);
        },
    };
}
