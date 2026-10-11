import type {
    MarkdownBlock,
    MarkdownBlockOptions,
    TopLevelMarkdownEntry,
} from './markdown-blocks.js';
import { parseTopLevelMarkdown } from './markdown-blocks.js';

/**
 * Parse-work accounting, the machine-independent measure the streaming regressions assert on.
 */
export interface StreamingMarkdownStats {
    /**
     * Calls that actually ran the Markdown engine; an unchanged source is answered from the cache.
     */
    parses: number;
    /**
     * Characters handed to the Markdown engine across every parse. A full re-parse per delta makes this grow with the
     * square of the reply length; the incremental parser keeps it a small multiple of the length.
     */
    parsedCharacters: number;
}

export interface StreamingMarkdownParser {
    /**
     * Returns the same blocks `parseMarkdownBlocks(source, options)` would, reusing the block objects of every
     * top-level construct a previous call already settled. Any source is accepted; the cache only decides how much work
     * is skipped, never the result.
     */
    parse: (source: string) => MarkdownBlock[];
    stats: () => StreamingMarkdownStats;
}

/**
 * Where a construct (a top-level block or a list item) starts in the current source.
 */
interface SourcePoint {
    line: number;
    offset: number;
    /**
     * Offset of the newline that ends the construct's first line, or `-1` while that line is unfinished.
     */
    lineEnd: number;
    /**
     * Offset of the newline that ends the line after the construct's first line, or `-1` while either line is
     * unfinished. Reusing the blocks before a top-level construct needs both: markdown-it decides whether a line opens
     * a table, which can interrupt the paragraph above it, by also reading the delimiter row below it.
     */
    settledEnd: number;
}

interface SettledEntry extends SourcePoint {
    block?: MarkdownBlock;
    list?: { marker: string; items: SourcePoint[] };
}

interface ParsedTail {
    entries: SettledEntry[];
    hasReferences: boolean;
}

/**
 * Markdown-it applies the same rewrite before splitting lines; doing it first keeps the cached offsets aligned with
 * markdown-it's line map without changing any parse result.
 */
function normalize(source: string): string {
    return source.replaceAll(/\r\n?/gu, '\n').replaceAll('\0', '\u{FFFD}');
}

function commonPrefixLength(left: string, right: string): number {
    if (right.startsWith(left)) return left.length;
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) index += 1;
    return index;
}

function lineOffsets(source: string): number[] {
    const offsets = [0];
    for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1))
        offsets.push(index + 1);
    return offsets;
}

const DOCUMENT_START: SourcePoint = { line: 0, offset: 0, lineEnd: -1, settledEnd: -1 };

function sourcePoint(source: string, line: number, offset: number): SourcePoint {
    const lineEnd = source.indexOf('\n', offset);
    return {
        line,
        offset,
        lineEnd,
        settledEnd: lineEnd === -1 ? -1 : source.indexOf('\n', lineEnd + 1),
    };
}

/**
 * Latest point in `points` (excluding the first) whose `until` offset is inside the unchanged prefix.
 */
function lastSettled(
    points: readonly SourcePoint[],
    shared: number,
    until: 'lineEnd' | 'settledEnd',
): number {
    for (let index = points.length - 1; index > 0; index -= 1) {
        const end = points[index]![until];
        if (end !== -1 && end < shared) return index;
    }
    return 0;
}

/**
 * Parses a growing Agent reply without re-parsing the whole text on every delta.
 *
 * CommonMark reads lines in order, and a construct starting at the top level means every construct before it was closed
 * by that line. Closed constructs never reopen, so once a top-level construct's first line and the line after it are
 * complete and unchanged, everything before it is final: only the source from that line on needs parsing again.
 * Requiring complete lines matters: a partial `1` after a list is a paragraph that closes the list, while the finished
 * `1. item` continues it, and a `| a |` line opens a table only if the next line is a delimiter row.
 *
 * The same holds one level down for a list, the most common shape of a long reply: a new item closes the items before
 * it, so the open list re-parses only from its latest settled item, and the earlier items are spliced back in. The
 * block tree records neither list tightness nor anything else a later item could change about an earlier one.
 *
 * A link reference definition is the one document-global construct, so a source markdown-it finds one in is always
 * parsed whole. Reused blocks and list items keep their object identity, so a memoized renderer skips them with a
 * reference check instead of a structural comparison. This is the block-level memoization Streamdown and LobeHub apply
 * by splitting a message into per-block source strings, but it keeps markdown-it as the only judge of where a block
 * ends.
 */
export function createStreamingMarkdownParser(
    options: MarkdownBlockOptions = {},
): StreamingMarkdownParser {
    let source: string | undefined;
    let hasReferences = false;
    let entries: SettledEntry[] = [];
    let blocks: MarkdownBlock[] = [];
    const stats: StreamingMarkdownStats = { parses: 0, parsedCharacters: 0 };

    function parseAt(next: string, from: SourcePoint): ParsedTail {
        const tail = next.slice(from.offset);
        const parsed = parseTopLevelMarkdown(tail, options);
        stats.parses += 1;
        stats.parsedCharacters += tail.length;
        const offsets = lineOffsets(tail);
        const point = (line: number) =>
            sourcePoint(next, from.line + line, from.offset + (offsets[line] ?? tail.length));
        return {
            entries: parsed.entries.map(({ block, line, list }: TopLevelMarkdownEntry) => ({
                ...point(line),
                ...(block && { block }),
                ...(list && { list: { marker: list.marker, items: list.itemLines.map(point) } }),
            })),
            hasReferences: parsed.hasReferences,
        };
    }

    /**
     * Re-parses an open list from its latest settled item and splices the earlier items back in. Returns `undefined`
     * when the re-parse does not continue the same list, which leaves the caller to parse the whole list again.
     */
    function parseListTail(next: string, open: SettledEntry, item: number): ParsedTail | undefined {
        const { block, list } = open;
        if (!list || block?.type !== 'list') return undefined;
        const parsed = parseAt(next, list.items[item]!);
        const [first, ...rest] = parsed.entries;
        const continued = first?.block;
        if (
            first?.line !== list.items[item]!.line ||
            continued?.type !== 'list' ||
            first.list?.marker !== list.marker
        )
            return undefined;
        const merged: SettledEntry = {
            ...open,
            block: { ...block, items: [...block.items.slice(0, item), ...continued.items] },
            list: {
                marker: list.marker,
                items: [...list.items.slice(0, item), ...first.list.items],
            },
        };
        return { entries: [merged, ...rest], hasReferences: parsed.hasReferences };
    }

    /**
     * Parses `next` reusing what the previous source settled. `kept` counts the reused leading entries; `partial` is
     * whether any part of the source, including the leading items of an open list, was not handed to markdown-it.
     */
    function parseIncrementally(next: string): {
        kept: number;
        parsed: ParsedTail;
        partial: boolean;
    } {
        if (source === undefined || hasReferences)
            return { kept: 0, parsed: parseAt(next, DOCUMENT_START), partial: false };
        const shared = commonPrefixLength(source, next);
        const kept = lastSettled(entries, shared, 'settledEnd');
        const open = entries[kept];
        /**
         * An item needs only its own line: a list marker line cannot become a table header, and when the re-parse no
         * longer reads it as an item of the same list, `parseListTail` falls back to the whole list.
         */
        const item = open?.list ? lastSettled(open.list.items, shared, 'lineEnd') : 0;
        const listTail = open && item > 0 ? parseListTail(next, open, item) : undefined;
        if (listTail) return { kept, parsed: listTail, partial: true };
        return {
            kept,
            parsed: parseAt(next, open && kept > 0 ? open : DOCUMENT_START),
            partial: kept > 0,
        };
    }

    return {
        parse(raw) {
            const next = normalize(raw);
            if (next === source) return blocks;
            let { kept, parsed, partial } = parseIncrementally(next);
            /**
             * A definition that first appears in the re-parsed source can change a reused block above it.
             */
            if (partial && parsed.hasReferences) {
                kept = 0;
                parsed = parseAt(next, DOCUMENT_START);
            }
            entries = [...entries.slice(0, kept), ...parsed.entries];
            hasReferences = parsed.hasReferences;
            blocks = entries.flatMap((entry) => (entry.block ? [entry.block] : []));
            source = next;
            return blocks;
        },
        stats: () => ({ ...stats }),
    };
}
