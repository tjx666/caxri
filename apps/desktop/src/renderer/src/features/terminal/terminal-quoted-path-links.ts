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
 * quotes a whole command as readily as a producer quotes a path, and neither `failed to run "/usr/bin/env node
 * --version"` nor `failed to run "/usr/bin/env node index.js"` must become one link: that would also suppress the
 * correct `/usr/bin/env` link the word pass already reports. Command arguments are indistinguishable from a bare
 * relative segment on shape alone (`index.js` and a spaced filename both end in an extension), so every continuation
 * except the last must itself carry a `/` to prove it is a path segment rather than a word; only the final continuation
 * may be a bare filename, which keeps `Application Support/…` and a spaced file name such as `My File.txt` while
 * rejecting trailing prose or a bare command argument. An option flag disqualifies the span outright at any position.
 * The accepted trade-off (see issue #1022) is that a real path with two or more interior spaces
 * (`/Users/me/Documents/My Project Files/a.txt`) falls back to the existing fragment-link behavior, because `Project`
 * alone cannot be told apart from a command argument either.
 */
function hasQuotedPathContinuations(candidate: string): boolean {
    const [, ...continuations] = candidate.split(/\s+/u);
    if (continuations.length === 0) return false;
    const lastIndex = continuations.length - 1;
    return continuations.every((continuation, index) => {
        if (continuation.startsWith('-')) return false;
        if (index < lastIndex) return continuation.includes('/');
        return /[/.]/u.test(continuation);
    });
}

interface TerminalLinkRange {
    endIndex: number;
    startIndex: number;
}

export interface QuotedPathLinkResult {
    links: TerminalLinkMatch[];
    /**
     * Ranges the word/token pass must never independently re-link. Covers every accepted `links` entry (so its interior
     * words are not re-reported) and, per issue #1022, every argument of a quoted span that opened like a path but
     * whose shape resolved to a command line instead (see {@link hasQuotedPathContinuations}): a trailing bare argument
     * such as `index.js` in `"/usr/bin/env node index.js"` would otherwise still qualify as its own bare-filename link
     * once the merged candidate is rejected. The leading segment (`/usr/bin/env`) is deliberately left out so the word
     * pass can still report it on its own.
     */
    excludedRanges: TerminalLinkRange[];
}

/**
 * Recovers a quoted path that contains spaces, which word tokenization can never produce: `tokenizeByWordSeparators`
 * splits at every whitespace character, so the long-paste receipt `Original file: "~/Library/Application Support/…"`
 * would otherwise surface as the misleading fragment `Support/…`. The pass stays deliberately narrow: the producer must
 * have quoted the candidate, the candidate must open with an explicit path marker, and every part after a space must
 * still look like path text, because a space inside an unquoted or unmarked candidate is indistinguishable from
 * ordinary prose.
 *
 * `urlLinks` follows source order, so each already accepted URL range is retired once instead of rescanning from the
 * first one.
 */
export function findQuotedPathLinks(
    text: string,
    urlLinks: TerminalLinkMatch[],
    wordSeparators: string,
): QuotedPathLinkResult {
    const links: TerminalLinkMatch[] = [];
    const excludedRanges: TerminalLinkRange[] = [];
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
        const startIndex = quoted.index + 1 + (inner.length - inner.trimStart().length);
        if (!hasQuotedPathContinuations(candidate)) {
            // See issue #1022: the arguments of a rejected quoted command line must stay unlinkable too.
            const firstSeparator = /\s+/u.exec(candidate);
            if (firstSeparator)
                excludedRanges.push({
                    endIndex: startIndex + candidate.length,
                    startIndex: startIndex + firstSeparator.index + firstSeparator[0].length,
                });
            continue;
        }
        const location = parseTerminalFileLocation(candidate);
        if (location.invalidLocation || !isLikelyFilePath(location.target)) continue;
        const endIndex = startIndex + candidate.length;
        while (urlLinks[urlIndex]?.endIndex <= startIndex) urlIndex += 1;
        const url = urlLinks.at(urlIndex);
        if (url && startIndex < url.endIndex && endIndex > url.startIndex) continue;
        links.push({ ...location, endIndex, kind: 'file', startIndex, text: candidate });
        excludedRanges.push({ endIndex, startIndex });
    }
    return { links, excludedRanges };
}
