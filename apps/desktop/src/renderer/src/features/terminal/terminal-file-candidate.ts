import { defaultAppSettings, parseFileLocation } from '@caxri/protocol';

import { trimTerminalLinkToken } from './terminal-link-token';

/**
 * Full-width brackets that open glued CJK prose such as `见（src/a.ts）`; a path never starts inside one.
 */
const CJK_OPENING_WRAPPERS = new Set(['（', '【', '「', '『', '《']);
export const CJK_PROSE_BOUNDARIES = new Set([
    '、',
    '，',
    '。',
    '；',
    '：',
    '！',
    '？',
    '（',
    '）',
    '【',
    '】',
    '「',
    '」',
    '『',
    '』',
    '《',
    '》',
]);

/**
 * Share the settings default so selection and fallback link detection cannot drift before settings load.
 */
export const TERMINAL_DEFAULT_WORD_SEPARATORS = defaultAppSettings['terminal.wordSeparators'];

/**
 * Only the current user's exact `~/...` shorthand is actionable. Server owns OS user lookup and deliberately rejects
 * other shell expansion forms so the Renderer never guesses at environment or account semantics.
 */
function isCurrentUserHomePath(path: string): boolean {
    return /^~\/.+/.test(path);
}

function isUnsupportedHomePath(path: string): boolean {
    return (
        path === '~' ||
        path === '~/' ||
        /^~[^/]+(?:\/|$)/.test(path) ||
        /^\$(?:HOME|\{HOME\})(?:\/|$)/.test(path)
    );
}

/**
 * Word separators can split unsupported Home syntax at any configured character and expose a suffix as a false file
 * link. Preserve its original-line range so none of the fragments can become actionable.
 */
export function unsupportedHomeRanges(
    text: string,
): Array<{ endIndex: number; startIndex: number }> {
    return Array.from(text.matchAll(/(?:~[^/\s]+|\$(?:HOME|\{HOME\}))\/\S*/gu), (match) => ({
        endIndex: match.index + match[0].length,
        startIndex: match.index,
    }));
}

export function isLikelyFilePath(path: string): boolean {
    if (/^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/i.test(path)) return false;
    if (isCurrentUserHomePath(path)) return true;
    if (isUnsupportedHomePath(path)) return false;
    if (/^file:\/\//i.test(path)) return true;
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return false;
    if (path === '/') return false;
    if (path.startsWith('/') || path.startsWith('./') || path.startsWith('../')) return true;
    /**
     * A slash alone is not enough evidence for bare CJK prose such as `账单/配置状态`. Require a Han final segment to look
     * like a filename; an extensionless target can still opt in with an explicit `./`, `../`, absolute, Home, or
     * file-URL prefix. ASCII extensionless paths such as `src/Makefile` retain the existing Terminal behavior.
     */
    if (path.includes('/')) {
        if (path.startsWith('-')) return false;
        const finalSegment = path.slice(path.lastIndexOf('/') + 1);
        if (!/\p{Script=Han}/u.test(finalSegment)) return true;
        return (
            /^\.[\w-]+$/u.test(finalSegment) || /^[^/:]+\.[a-z\d][\w-]{0,15}$/iu.test(finalSegment)
        );
    }
    return /^[^/:]+\.[a-z\d][\w-]{0,15}$/i.test(path);
}

/**
 * A bare first segment containing sentence punctuation is indistinguishable from adjacent CJK prose, so it must not
 * become a link by guessing where the path starts. Explicit `./`, `../`, `/`, and `file://` candidates are detached
 * before this check, while punctuation in later segments remains unambiguous.
 */
export function hasAmbiguousCjkProsePrefix(path: string): boolean {
    const firstSlash = path.indexOf('/');
    if (firstSlash <= 0) return false;
    for (let index = 0; index < firstSlash; index += 1) {
        if (CJK_PROSE_BOUNDARIES.has(path[index])) return true;
    }
    return false;
}

export interface RawToken {
    index: number;
    text: string;
}

/**
 * Detaches a path suffix from CJK prose when the suffix has an explicit path marker or follows a CJK label colon or
 * full-width opening bracket. Bare Project-relative paths after sentence punctuation remain ambiguous
 * (`目录。version/file.ts` may be one valid path), so treating every CJK punctuation mark as a separator would corrupt
 * them, while `见（src/a.ts）` cannot be one path. A CJK label colon or a full-width colon followed by an explicit path
 * marker is structural even with custom word separators; other implicit boundaries apply only to the default setting so
 * custom separators retain tokenization control.
 */
export function detachPathCandidateFromCjkProse(token: RawToken, wordSeparators: string): RawToken {
    const hasDefaultWordSeparators = wordSeparators === TERMINAL_DEFAULT_WORD_SEPARATORS;
    if (!hasDefaultWordSeparators && !token.text.includes('：')) return token;
    const firstSlash = token.text.indexOf('/');
    const searchStart = (firstSlash === -1 ? token.text.length : firstSlash) - 1;
    const firstCjkCharacter = token.text.search(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
    );
    for (let index = searchStart; index >= 0; index -= 1) {
        const character = token.text[index];
        /**
         * A CJK label's colon introduces a bare relative path. Limit this to the first segment so colons in explicit
         * paths and the `file://` scheme keep their meaning; line/column suffixes are parsed separately.
         */
        const isCjkLabelColon =
            (character === ':' || character === '：') &&
            firstCjkCharacter >= 0 &&
            firstCjkCharacter < index;
        const isConfiguredBoundary =
            hasDefaultWordSeparators && CJK_PROSE_BOUNDARIES.has(character);
        const isFullWidthColon = character === '：';
        if (!isFullWidthColon && !isCjkLabelColon && !isConfiguredBoundary) continue;
        const suffix = token.text.slice(index + 1);
        const candidate = suffix.slice(0, trailingCjkProseOffset(suffix, wordSeparators));
        const trimmed = trimTerminalLinkToken(candidate);
        const hasExplicitPathMarker =
            trimmed.text.startsWith('.') ||
            trimmed.text.startsWith('/') ||
            isCurrentUserHomePath(trimmed.text) ||
            /^file:\/\//i.test(trimmed.text);
        const isLabelColon = isCjkLabelColon;
        if (!hasExplicitPathMarker && !isLabelColon && !CJK_OPENING_WRAPPERS.has(character))
            return token;
        if (!trimmed.text || !isLikelyFilePath(parseFileLocation(trimmed.text).target))
            return token;
        return { index: token.index + index + 1, text: suffix };
    }
    return token;
}

/**
 * A filename and its `:line:column` or `#L` suffix are short, so the enumeration test below inspects a bounded tail
 * rather than slicing the whole prefix at every boundary; a line made of CJK punctuation would otherwise cost a
 * quadratic scan.
 */
const ENUMERATED_PATH_TAIL_LENGTH = 64;

function hasFileNameBefore(text: string, end: number): boolean {
    const tail = text.slice(Math.max(0, end - ENUMERATED_PATH_TAIL_LENGTH), end);
    const { target } = parseFileLocation(tail.slice(tail.lastIndexOf('/') + 1));
    return /^\.[\w-]+$/u.test(target) || /^[^/:]+\.[a-z\d][\w-]{0,15}$/iu.test(target);
}

/**
 * Start offset of the last path in a CJK enumeration such as `src/a.ts:10、src/b.ts:20`. Location parsing walks back to
 * whitespace so a configured word separator can stay inside a path, which also lets it swallow the enumeration comma
 * and report `src/a.ts:10、src/b.ts` as one target; `detachPathCandidateFromCjkProse` cannot see that comma because it
 * only inspects the text before the first slash. Cut after a boundary only when the text before it already ends in a
 * filename, so a directory legitimately containing CJK punctuation (`docs/目录。版本/file.ts`) keeps its protection: a
 * directory whose name ends in a filename shape (`docs/v1.0。版本/`) is the accepted trade-off. Custom word separators
 * retain exact tokenization control.
 */
export function enumeratedPathCandidateStart(text: string, wordSeparators: string): number {
    if (wordSeparators !== TERMINAL_DEFAULT_WORD_SEPARATORS) return 0;
    for (let index = text.length - 2; index > 0; index -= 1) {
        if (CJK_PROSE_BOUNDARIES.has(text[index]) && hasFileNameBefore(text, index))
            return index + 1;
    }
    return 0;
}

/**
 * Agent prose often glues a full-width note such as `（后者含密钥）。` directly onto a path, and the default word separators
 * contain no CJK punctuation. Only the final path segment is cut so CJK punctuation inside earlier directory names
 * (`docs/目录。版本/file.ts`) keeps its existing protection; custom word separators retain exact tokenization control.
 */
export function trailingCjkProseOffset(text: string, wordSeparators: string): number {
    if (wordSeparators !== TERMINAL_DEFAULT_WORD_SEPARATORS) return text.length;
    for (let index = text.lastIndexOf('/') + 1; index < text.length; index += 1) {
        if (CJK_PROSE_BOUNDARIES.has(text[index])) return index;
    }
    return text.length;
}
