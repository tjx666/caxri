const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const WHITESPACE = /\s/u;
/**
 * Where a multiline `^` matches after, which is every JavaScript line terminator rather than only `\n`.
 */
const LINE_TERMINATOR = /[\n\r\u{2028}\u{2029}]/u;

/**
 * An emphasis marker's tally over the scanned part of the last block: how many there are and where the last one is.
 * `isLastOpening` records whether that last one is followed by a non-space, the condition for it to open a span.
 */
interface MarkerTally {
    count: number;
    last: number | undefined;
    isLastOpening: boolean;
}

/**
 * Everything the closers depend on, accumulated left to right over the last block, so complete lines are scanned once
 * instead of once per delta. Positions are offsets into the whole source.
 */
interface SpanTally {
    /**
     * Single backticks; runs of two or more never count.
     */
    ticks: number;
    lastTick: number | undefined;
    /**
     * Whether the scan stands inside an inline code span, whose content does not count as emphasis.
     */
    isInCode: boolean;
    /**
     * Whether only whitespace has followed the last line start, so a `*` here is a list bullet rather than emphasis.
     */
    isLineLead: boolean;
    bold: MarkerTally;
    strike: MarkerTally;
    star: MarkerTally;
}

function emptyMarker(): MarkerTally {
    return { count: 0, last: undefined, isLastOpening: false };
}

function emptyTally(): SpanTally {
    return {
        ticks: 0,
        lastTick: undefined,
        isInCode: false,
        isLineLead: true,
        bold: emptyMarker(),
        strike: emptyMarker(),
        star: emptyMarker(),
    };
}

function cloneTally(tally: SpanTally): SpanTally {
    return {
        ...tally,
        bold: { ...tally.bold },
        strike: { ...tally.strike },
        star: { ...tally.star },
    };
}

/**
 * Counts non-overlapping occurrences of `marker`, left to right, the way a repeated `indexOf` pairs them.
 */
function tallyMarker(tally: MarkerTally, text: string, marker: string, offset: number): void {
    for (let index = text.indexOf(marker); index !== -1;) {
        tally.count += 1;
        tally.last = offset + index;
        const next = text[index + marker.length];
        tally.isLastOpening = next !== undefined && !WHITESPACE.test(next);
        index = text.indexOf(marker, index + marker.length);
    }
}

/**
 * Adds `segment` (which starts at `offset` in the source) to `tally`. Segments are fed in order and every one but the
 * last ends with a newline, so no backtick run or emphasis marker straddles two segments; the only state that crosses
 * is an open code span and an unfinished line lead, both carried in `tally`.
 */
function tallySegment(tally: SpanTally, segment: string, offset: number): void {
    let masked = '';
    for (let index = 0; index < segment.length; index += 1) {
        const character = segment[index]!;
        if (character === '`') {
            tally.lastTick = offset + index;
            if (segment[index - 1] !== '`' && segment[index + 1] !== '`') tally.ticks += 1;
        }
        // Code span content, both backticks included, is blanked so it never counts as emphasis.
        if (tally.isInCode) {
            masked += ' ';
            if (character === '`') tally.isInCode = false;
        } else if (character === '`') {
            masked += ' ';
            tally.isInCode = true;
        } else masked += character;
    }
    tallyMarker(tally.bold, masked, '**', offset);
    tallyMarker(tally.strike, masked, '~~', offset);
    // Doubled markers are blanked first, then a line-leading `*` followed by whitespace, which is a list bullet.
    const doubled = masked.replaceAll('**', '  ');
    let singles = '';
    for (let index = 0; index < doubled.length; index += 1) {
        const character = doubled[index]!;
        if (tally.isLineLead && !WHITESPACE.test(character)) {
            tally.isLineLead = false;
            const next = doubled[index + 1];
            if (character === '*' && next !== undefined && WHITESPACE.test(next)) {
                singles += ' ';
                continue;
            }
        }
        if (LINE_TERMINATOR.test(character)) tally.isLineLead = true;
        singles += character;
    }
    tallyMarker(tally.star, singles, '*', offset);
}

/**
 * Scan state of the last block over complete lines. `fence` and `start` follow the rules of a full scan; `tally` covers
 * `[start, pendingLine)` and lags one line behind, because finishing the reply's last line can still trim the line
 * before it.
 */
interface LineScan {
    fence: string | undefined;
    start: number;
    /**
     * End of the complete lines scanned so far, just past their final newline.
     */
    scanned: number;
    /**
     * Start of the last complete line, which the tally has not taken in yet.
     */
    pendingLine: number | undefined;
    tally: SpanTally;
}

function emptyScan(): LineScan {
    return { fence: undefined, start: 0, scanned: 0, pendingLine: undefined, tally: emptyTally() };
}

function isFenceCloser(fence: string, line: string, marker: string | undefined): boolean {
    return (
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
    );
}

/**
 * Advances `scan` past one line and answers whether that line moved the last block's start.
 */
function hasLineMovedStart(scan: LineScan, line: string, offset: number): boolean {
    const marker = FENCE.exec(line)?.[1];
    if (scan.fence) {
        if (isFenceCloser(scan.fence, line, marker)) scan.fence = undefined;
        return false;
    }
    if (marker) {
        scan.fence = marker;
        scan.start = offset;
        return true;
    }
    if (line.trim() !== '') return false;
    scan.start = offset + line.length + 1;
    return true;
}

export interface StreamingMarkdownRepairStats {
    /**
     * Source characters the repair examined, counted across every call. The native check that a source extends the
     * previous one is not counted.
     */
    scannedCharacters: number;
}

export interface StreamingMarkdownRepair {
    repair(source: string): string;
    stats(): StreamingMarkdownRepairStats;
}

/**
 * A `repairStreamingMarkdown` that remembers one streaming reply. Complete lines are scanned once and their effect on
 * the last block is kept, so a delta that extends the previous source costs only its own last two lines, however long
 * the reply or its last block (a long list has no blank line to end it). Any other source starts the scan over. The
 * output is identical to a fresh `repairStreamingMarkdown` call.
 */
export function createStreamingMarkdownRepair(): StreamingMarkdownRepair {
    let scan = emptyScan();
    let scannedText = '';
    let scannedCharacters = 0;

    function advance(source: string): void {
        if (!source.startsWith(scannedText)) scan = emptyScan();
        for (let end = source.indexOf('\n', scan.scanned); end !== -1;) {
            const offset = scan.scanned;
            const line = source.slice(offset, end);
            scannedCharacters += line.length + 1;
            const hasMovedStart = hasLineMovedStart(scan, line, offset);
            const pending = scan.pendingLine;
            if (hasMovedStart) scan.tally = emptyTally();
            else if (pending !== undefined && pending >= scan.start)
                tallySegment(scan.tally, source.slice(pending, offset), pending);
            scan.pendingLine = offset;
            scan.scanned = end + 1;
            end = source.indexOf('\n', scan.scanned);
        }
        scannedText = source.slice(0, scan.scanned);
    }

    return {
        repair(source) {
            advance(source);
            const lastLine = source.slice(scan.scanned);
            scannedCharacters += lastLine.length;
            // The unfinished line can still open a fence or blank the block; either leaves the source as it is.
            const lastScan = { ...scan };
            if (hasLineMovedStart(lastScan, lastLine, scan.scanned) || lastScan.fence)
                return source;
            const { pendingLine } = scan;
            const freshStart =
                pendingLine !== undefined && pendingLine >= scan.start ? pendingLine : scan.start;
            let fresh = source.slice(freshStart);
            scannedCharacters += fresh.length - lastLine.length;
            /**
             * Every rewrite below is anchored to the end of the text and cannot cross a blank line, so applying it to
             * the last two lines rewrites exactly what applying it to the whole block would.
             *
             * A lone `-` or `=` under a line is a setext heading underline to markdown-it; mid-stream it is almost
             * always the first character of the next list item.
             */
            fresh = fresh.replace(/\n {0,3}[-=]\s*$/u, '\n');
            /**
             * `[label](partial-url` renders as literal source until its `)` arrives; show the label alone meanwhile.
             */
            fresh = fresh.replace(/!?\[([^\]\n]*)\]\([^)\s]*$/u, '$1');
            fresh = fresh.replace(/!?\[([^\]\n]*)$/u, '$1');
            const trimmed = fresh.trimEnd();
            /**
             * A marker the reply has opened but not yet followed with text renders as itself; hold it back.
             */
            const dangling = /(?:^|\s)(\*{1,2}|~~|`)$/u.exec(trimmed);
            if (dangling) fresh = trimmed.slice(0, trimmed.length - dangling[1]!.length);
            const tally = cloneTally(scan.tally);
            tallySegment(tally, fresh, freshStart);
            const closers: Array<{ at: number; marker: string }> = [];
            if (tally.ticks % 2 === 1) closers.push({ at: tally.lastTick!, marker: '`' });
            for (const [marker, counted] of [
                ['**', tally.bold],
                ['~~', tally.strike],
                ['*', tally.star],
            ] as const) {
                if (counted.count % 2 === 1 && counted.isLastOpening)
                    closers.push({ at: counted.last!, marker });
            }
            const repaired = source.slice(0, freshStart) + fresh;
            if (closers.length === 0) return repaired;
            /**
             * Innermost (latest-opened) span closes first so nesting stays well-formed: `**bold *it` gets `*` then
             * `**`.
             */
            const suffix = closers
                .toSorted((left, right) => right.at - left.at)
                .map(({ marker }) => marker)
                .join('');
            return repaired.trimEnd() + suffix;
        },
        stats: () => ({ scannedCharacters }),
    };
}

/**
 * Completes the Markdown a streaming reply has not finished writing yet, so the partial text renders the way its final
 * form will instead of flashing raw syntax: an open `**bold`, `~~strike`, `*emphasis`, or ``code`span is closed, a
 * half-written link shows only its text, and a dangling marker or lone`-` at the very end is held back.
 *
 * Only the last block is touched; everything before it is final Markdown. Content inside an open code fence is never
 * changed. Apply this to in-flight text only: a finished reply renders exactly as written. A caller that repairs the
 * same reply on every delta should keep one `createStreamingMarkdownRepair` instead, which does not rescan the reply.
 */
export function repairStreamingMarkdown(source: string): string {
    return createStreamingMarkdownRepair().repair(source);
}
