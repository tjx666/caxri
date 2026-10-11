const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/**
 * Index where the last block starts, or `undefined` when the source ends inside an open code fence. An open fence
 * already renders as code to the end, and anything inside it must stay byte-exact.
 */
function tailStart(source: string): number | undefined {
    let fence: string | undefined;
    let start = 0;
    let offset = 0;
    for (const line of source.split('\n')) {
        const marker = FENCE.exec(line)?.[1];
        if (fence) {
            const isCloser =
                marker !== undefined &&
                marker[0] === fence[0] &&
                marker.length >= fence.length &&
                line.trim() === marker;
            if (isCloser) fence = undefined;
        } else if (marker) {
            fence = marker;
            start = offset;
        } else if (line.trim() === '') {
            start = offset + line.length + 1;
        }
        offset += line.length + 1;
    }
    return fence ? undefined : Math.min(start, source.length);
}

/**
 * Removes inline code spans so their content does not count as emphasis markers. An unclosed span is masked to the end
 * of the text, because the closing backtick appended for it turns that remainder into code too.
 */
function maskCode(text: string): string {
    return text.replaceAll(/`[^`]*(?:`|$)/gu, (span) => ' '.repeat(span.length));
}

/**
 * Last opener of `marker` that has no closer, provided it can actually open emphasis (followed by a non-space).
 */
function unmatchedOpener(masked: string, marker: string): number | undefined {
    const positions: number[] = [];
    for (let index = masked.indexOf(marker); index !== -1;) {
        positions.push(index);
        index = masked.indexOf(marker, index + marker.length);
    }
    if (positions.length % 2 === 0) return undefined;
    const last = positions.at(-1)!;
    const next = masked[last + marker.length];
    return next === undefined || /\s/u.test(next) ? undefined : last;
}

/**
 * The single `*` emphasis markers in `masked`: doubled markers and list bullets are blanked so they are not counted.
 */
function singleStars(masked: string): string {
    return masked.replaceAll('**', '  ').replaceAll(/^(\s*)\*(?=\s)/gmu, '$1 ');
}

/**
 * The rescan-everything implementation `createStreamingMarkdownRepair` replaced, frozen as the oracle the incremental
 * one must match byte for byte (issue caxri#1666).
 */
export function referenceRepair(source: string): string {
    const start = tailStart(source);
    if (start === undefined) return source;
    const head = source.slice(0, start);
    let tail = source.slice(start);
    /**
     * A lone `-` or `=` under a line is a setext heading underline to markdown-it; mid-stream it is almost always the
     * first character of the next list item.
     */
    tail = tail.replace(/\n {0,3}[-=]\s*$/u, '\n');
    /**
     * `[label](partial-url` renders as literal source until its `)` arrives; show the label alone meanwhile.
     */
    tail = tail.replace(/!?\[([^\]\n]*)\]\([^)\s]*$/u, '$1');
    tail = tail.replace(/!?\[([^\]\n]*)$/u, '$1');
    const trimmed = tail.trimEnd();
    /**
     * A marker the reply has opened but not yet followed with text renders as itself; hold it back.
     */
    const dangling = /(?:^|\s)(\*{1,2}|~~|`)$/u.exec(trimmed);
    if (dangling) tail = trimmed.slice(0, trimmed.length - dangling[1]!.length);
    const closers: Array<{ at: number; marker: string }> = [];
    const ticks = tail.replaceAll(/`{2,}/gu, '').split('`').length - 1;
    if (ticks % 2 === 1) closers.push({ at: tail.lastIndexOf('`'), marker: '`' });
    const masked = maskCode(tail);
    for (const marker of ['**', '~~']) {
        const at = unmatchedOpener(masked, marker);
        if (at !== undefined) closers.push({ at, marker });
    }
    const star = unmatchedOpener(singleStars(masked), '*');
    if (star !== undefined) closers.push({ at: star, marker: '*' });
    if (closers.length === 0) return head + tail;
    /**
     * Innermost (latest-opened) span closes first so nesting stays well-formed: `**bold *it` gets `*` then `**`.
     */
    const suffix = closers
        .toSorted((left, right) => right.at - left.at)
        .map(({ marker }) => marker)
        .join('');
    return head + tail.trimEnd() + suffix;
}
