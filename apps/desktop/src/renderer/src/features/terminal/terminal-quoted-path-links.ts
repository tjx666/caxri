import { isLikelyFilePath, trailingCjkProseOffset } from './terminal-file-candidate';
import { parseTerminalFileLocation } from './terminal-file-location';
import type { TerminalLinkMatch } from './terminal-links';

/**
 * A quoted span is the only place a space can stay inside a path candidate. The opener must not follow a letter or a
 * digit so an apostrophe in prose (`can't open '/a b/c.txt'`) cannot consume the real opening quote, and only the
 * opener's own character closes the span so a legal apostrophe inside a macOS folder name (`Bob's Notes`) survives.
 */
const QUOTED_LINK_PATTERN = /(?<![\p{L}\p{N}])(["'`])((?:(?!\1)[^\n])+)\1/gu;
/**
 * Spaces are only trustworthy inside a candidate that also announces itself as a path, so quoted prose such as `"could
 * not find the file"` stays out of the file pass.
 */
const EXPLICIT_PATH_MARKER_PATTERN = /^(?:\/|~\/|\.\.?\/|file:\/\/)/iu;

/**
 * Accepts a spaced quoted span only when every part after the first space still reads as path text. A shell error
 * quotes a whole command as readily as a producer quotes a path, and `failed to run "/usr/bin/env node --version"` must
 * not become one link — that would also suppress the correct `/usr/bin/env` link the word pass already reports. An
 * option flag disqualifies the span outright, and the closing part must carry a separator or an extension dot, which
 * keeps `Application Support/…` and a spaced file name such as `My File.txt` while rejecting trailing prose.
 */
function hasQuotedPathContinuations(candidate: string): boolean {
    const [, ...continuations] = candidate.split(/\s+/u);
    const closing = continuations.at(-1);
    return (
        closing !== undefined &&
        /[/.]/u.test(closing) &&
        continuations.every((continuation) => !continuation.startsWith('-'))
    );
}

/**
 * Recovers a quoted path that contains spaces, which word tokenization can never produce: `tokenizeByWordSeparators`
 * splits at every whitespace character, so the long-paste receipt `Original file: "~/Library/Application Support/…"`
 * would otherwise surface as the misleading fragment `Support/…`. The pass stays deliberately narrow — the producer
 * must have quoted the candidate, the candidate must open with an explicit path marker, and every part after a space
 * must still look like path text — because a space inside an unquoted or unmarked candidate is indistinguishable from
 * ordinary prose.
 *
 * `urlLinks` follows source order, so each already accepted URL range is retired once instead of rescanning from the
 * first one.
 */
export function findQuotedPathLinks(
    text: string,
    urlLinks: TerminalLinkMatch[],
    wordSeparators: string,
): TerminalLinkMatch[] {
    const links: TerminalLinkMatch[] = [];
    let urlIndex = 0;
    for (const quoted of text.matchAll(QUOTED_LINK_PATTERN)) {
        const inner = quoted[2];
        const spanned = inner.trim();
        /**
         * Agent prose glues a full-width note onto the closing segment inside the quotes as well, so the quoted pass
         * cuts it with the same helper the token pass uses instead of inventing a second CJK rule.
         */
        const candidate = spanned
            .slice(0, trailingCjkProseOffset(spanned, wordSeparators))
            .trimEnd();
        /**
         * A candidate without an interior space is already reported by the token pass, which trims the quotes as
         * wrapper characters; re-reporting it here would duplicate the link.
         */
        if (!/\s/u.test(candidate) || !EXPLICIT_PATH_MARKER_PATTERN.test(candidate)) continue;
        if (!hasQuotedPathContinuations(candidate)) continue;
        const location = parseTerminalFileLocation(candidate);
        if (location.invalidLocation || !isLikelyFilePath(location.target)) continue;
        const startIndex = quoted.index + 1 + (inner.length - inner.trimStart().length);
        const endIndex = startIndex + candidate.length;
        while (urlLinks[urlIndex]?.endIndex <= startIndex) urlIndex += 1;
        const url = urlLinks.at(urlIndex);
        if (url && startIndex < url.endIndex && endIndex > url.startIndex) continue;
        links.push({ ...location, endIndex, kind: 'file', startIndex, text: candidate });
    }
    return links;
}
