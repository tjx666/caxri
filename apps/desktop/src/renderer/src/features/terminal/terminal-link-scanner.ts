import type { Terminal } from '@xterm/xterm';

import type {
    TerminalDetectedLink,
    TerminalDetectedLinkBudget,
    TerminalLinkContext,
} from './terminal-links';
import {
    appendBoundedDetectedLink,
    createDetectedLink,
    findContextTerminalLinks,
    readLogicalLine,
} from './terminal-links';
import type { VisibleOscLink } from './terminal-osc-link-tracker';

export type TerminalLinkScanStatus = 'complete' | 'exhausted' | 'scanning';

interface TerminalLinkScanChunk {
    links: TerminalDetectedLink[];
    status: TerminalLinkScanStatus;
}

export interface TerminalLinkScanner {
    /**
     * Scans at most one bounded chunk of buffer lines and returns the accumulated result so far. The caller
     * (`hooks/use-terminal-link-picker.ts`) reschedules the next call with `requestAnimationFrame` while `status` is
     * `'scanning'`, so a large scrollback time-slices across frames instead of blocking the Renderer in one synchronous
     * pass.
     */
    scanNextChunk(): TerminalLinkScanChunk;
}

/**
 * Caps how many buffer lines one `scanNextChunk` call inspects while walking retained scrollback above the viewport, so
 * opening the picker against a busy build log time-slices across animation frames instead of blocking the Renderer with
 * one unbounded synchronous pass over the whole buffer.
 */
const SCROLLBACK_LINK_SCAN_CHUNK_LINES = 500;

/**
 * Scans buffer rows `fromLine`..`toLine` (inclusive, walking in `step`'s direction) for plain-text link candidates,
 * appending accepted matches into `budget`. Shared by the viewport and scrollback phases of `createTerminalLinkScanner`
 * so both apply the same wrapped-line dedupe and bounded-budget accounting.
 */
function scanPlainTextLineRange(
    terminal: Terminal,
    context: TerminalLinkContext,
    budget: TerminalDetectedLinkBudget,
    visitedLogicalLines: Set<number>,
    fromLine: number,
    toLine: number,
    step: 1 | -1,
): 'exhausted' | 'ok' {
    for (let line = fromLine; step === 1 ? line <= toLine : line >= toLine; line += step) {
        const logicalLine = readLogicalLine(terminal, line + 1, context.wordSeparators);
        if (!logicalLine || visitedLogicalLines.has(logicalLine.firstBufferLine)) continue;
        visitedLogicalLines.add(logicalLine.firstBufferLine);
        for (const match of findContextTerminalLinks(logicalLine.text, context)) {
            const key = `${match.kind}:${match.text}`;
            const result = appendBoundedDetectedLink(budget, key, match.text, () =>
                createDetectedLink(
                    match,
                    context,
                    `plain:${logicalLine.firstBufferLine}:${match.startIndex}:${match.endIndex}`,
                    logicalLine.firstBufferLine,
                ),
            );
            if (result === 'exhausted') return 'exhausted';
        }
    }
    return 'ok';
}

/**
 * Appends already-tracked OSC 8 links whose start line falls in `[minLine, maxLine]`. OSC links are cheap to revisit
 * per chunk: the tracker retains only a bounded, already-validated set (`terminal-osc-link-tracker.ts`), so filtering
 * by range needs no Terminal text scan.
 */
function appendOscLinksInRange(
    context: TerminalLinkContext,
    budget: TerminalDetectedLinkBudget,
    oscLinks: readonly VisibleOscLink[],
    minLine: number,
    maxLine: number,
): 'exhausted' | 'ok' {
    for (const link of oscLinks) {
        if (link.bufferLine < minLine || link.bufferLine > maxLine) continue;
        const key = `${link.match.kind}:${link.match.text}`;
        const result = appendBoundedDetectedLink(budget, key, link.match.text, () =>
            createDetectedLink(link.match, context, link.id, link.bufferLine),
        );
        if (result === 'exhausted') return 'exhausted';
    }
    return 'ok';
}

/**
 * Drives the link picker's `Cmd+Shift+O` scan: the visible viewport first (existing `getViewportLinks` order), then the
 * retained scrollback above it walked upward (most recent first) in bounded chunks. One `TerminalDetectedLinkBudget` is
 * shared across every chunk, so the combined result never exceeds `MAX_TERMINAL_DETECTED_LINKS` /
 * `MAX_TERMINAL_DETECTED_LINK_TARGET_BYTES` regardless of how much scrollback is scanned.
 */
export function createTerminalLinkScanner(
    terminal: Terminal,
    context: TerminalLinkContext,
    oscLinks: readonly VisibleOscLink[],
): TerminalLinkScanner {
    const buffer = terminal.buffer.active;
    const firstVisibleLine = buffer.viewportY;
    const lastVisibleLine = Math.min(buffer.length - 1, firstVisibleLine + terminal.rows - 1);
    const budget: TerminalDetectedLinkBudget = {
        links: [],
        targetBytes: 0,
        uniqueTargets: new Set(),
    };
    const visitedLogicalLines = new Set<number>();
    let phase: 'done' | 'scrollback' | 'viewport' = 'viewport';
    let nextScrollbackLine = firstVisibleLine - 1;
    let isExhausted = false;

    return {
        scanNextChunk(): TerminalLinkScanChunk {
            if (!isExhausted && phase === 'viewport') {
                if (
                    scanPlainTextLineRange(
                        terminal,
                        context,
                        budget,
                        visitedLogicalLines,
                        firstVisibleLine,
                        lastVisibleLine,
                        1,
                    ) === 'exhausted' ||
                    appendOscLinksInRange(
                        context,
                        budget,
                        oscLinks,
                        firstVisibleLine,
                        lastVisibleLine,
                    ) === 'exhausted'
                )
                    isExhausted = true;
                phase = 'scrollback';
            } else if (!isExhausted && phase === 'scrollback') {
                if (nextScrollbackLine < 0) {
                    phase = 'done';
                } else {
                    const chunkTo = Math.max(
                        0,
                        nextScrollbackLine - SCROLLBACK_LINK_SCAN_CHUNK_LINES + 1,
                    );
                    if (
                        scanPlainTextLineRange(
                            terminal,
                            context,
                            budget,
                            visitedLogicalLines,
                            nextScrollbackLine,
                            chunkTo,
                            -1,
                        ) === 'exhausted' ||
                        appendOscLinksInRange(
                            context,
                            budget,
                            oscLinks,
                            chunkTo,
                            nextScrollbackLine,
                        ) === 'exhausted'
                    )
                        isExhausted = true;
                    nextScrollbackLine = chunkTo - 1;
                    if (nextScrollbackLine < 0) phase = 'done';
                }
            }
            const status: TerminalLinkScanStatus = isExhausted
                ? 'exhausted'
                : phase === 'done'
                  ? 'complete'
                  : 'scanning';
            return { links: [...budget.links], status };
        },
    };
}
