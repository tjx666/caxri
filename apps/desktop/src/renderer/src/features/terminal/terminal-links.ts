import type { EditorNavigationTarget, TerminalOscLinkSnapshot } from '@caxri/protocol';
import type { ILink, Terminal } from '@xterm/xterm';

import {
    parseTerminalFileLocation,
    TERMINAL_FILE_LOCATION_SUFFIX_PATTERN,
} from './terminal-file-location';
import type { TerminalLogicalLine } from './terminal-logical-line';
import { joinTerminalLogicalLines, readSoftWrappedLogicalLine } from './terminal-logical-line';
import type { VisibleOscLink } from './terminal-osc-link-tracker';
import {
    MAX_TERMINAL_LINK_LENGTH as MAX_LOGICAL_LINE_LENGTH,
    MAX_TERMINAL_LINK_ROWS as MAX_LOGICAL_LINE_ROWS,
    registerTerminalOscLinkTracker,
} from './terminal-osc-link-tracker';

const CJK_PROSE_BOUNDARIES = new Set(['、', '，', '。', '；', '：', '！', '？']);
const LEADING_WRAPPERS = new Set(['(', '[', '{', '<', '"', "'", '`']);
const EXPLICIT_TERMINAL_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
/**
 * Plain text needs explicit CJK prose boundaries while OSC 8 targets retain every valid Unicode URL character.
 */
const PLAIN_TEXT_URL_PATTERN = /https?:\/\/[^\s<>"'`、，。；：！？）]+/giu;
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '"', "'", '`']);

/**
 * Matches the VS Code `terminal.integrated.wordSeparators` default (leading space included). The
 * `terminal.wordSeparators` setting overrides it; this constant is only the not-yet-loaded fallback.
 */
export const TERMINAL_DEFAULT_WORD_SEPARATORS = ' ()[]{}\',"`─‘’“”|';

/**
 * The picker uses a non-virtualized cmdk list, so both descriptor count and retained target bytes need hard bounds even
 * when an artificially large Terminal viewport is filled with short links.
 */
export const MAX_TERMINAL_DETECTED_LINKS = 200;
export const MAX_TERMINAL_DETECTED_LINK_TARGET_BYTES = 64 * 1_024;

const terminalLinkTextEncoder = new TextEncoder();

export interface TerminalDetectedLinkBudget {
    links: TerminalDetectedLink[];
    targetBytes: number;
    uniqueTargets: Set<string>;
}

export function appendBoundedDetectedLink(
    budget: TerminalDetectedLinkBudget,
    key: string,
    target: string,
    createLink: () => TerminalDetectedLink,
): 'accepted' | 'duplicate' | 'exhausted' {
    if (budget.uniqueTargets.has(key)) return 'duplicate';
    const candidateBytes = terminalLinkTextEncoder.encode(target).byteLength;
    if (
        budget.links.length >= MAX_TERMINAL_DETECTED_LINKS ||
        budget.targetBytes + candidateBytes > MAX_TERMINAL_DETECTED_LINK_TARGET_BYTES
    )
        return 'exhausted';
    budget.links.push(createLink());
    budget.uniqueTargets.add(key);
    budget.targetBytes += candidateBytes;
    return 'accepted';
}

export interface TerminalLinkMatch {
    endIndex: number;
    kind: 'file' | 'url';
    startIndex: number;
    target: string;
    text: string;
    location?: EditorNavigationTarget;
}

/**
 * Content-free work counters used to keep adversarial link scans deterministic in tests. The scanner never records the
 * Terminal text or matched targets here.
 */
export interface TerminalLinkScanMetrics {
    detectedLinkRangeVisits: number;
    unsupportedHomeRangeVisits: number;
}

export interface TerminalLinkContext {
    wordSeparators: string;
    openFile(target: string, location?: EditorNavigationTarget): void;
    openUrl(url: string): void;
}

export interface TerminalDetectedLink {
    accessibleName: string;
    bufferLine: number;
    detail?: string;
    id: string;
    kind: TerminalLinkMatch['kind'];
    target: string;
    activate(): void;
}

export interface TerminalLinkRegistration {
    /**
     * Creates a fresh, single-use scan across the visible viewport and then the retained scrollback (most recent
     * first). Call `scanNextChunk()` repeatedly until its `status` is no longer `'scanning'`; see
     * `createTerminalLinkScanner` for the budget and chunking contract.
     */
    dispose(): void;
    getAllOscLinks(): VisibleOscLink[];
    getViewportLinks(): TerminalDetectedLink[];
    restoreOscLinks(snapshots: readonly TerminalOscLinkSnapshot[]): void;
}

type ClosingBracket = ')' | ']' | '}';

function closingBracket(value: string): ClosingBracket | undefined {
    return [')', ']', '}'].includes(value) ? (value as ClosingBracket) : undefined;
}

/**
 * Maps each opening/closing bracket character to the closer it affects and the amount by which it shifts that closer's
 * outstanding count, so `trimToken` can update `bracketExcess` without a `switch`/`break` inside its loop.
 */
const BRACKET_EXCESS_ADJUSTMENTS: Partial<Record<string, readonly [ClosingBracket, number]>> = {
    '(': [')', -1],
    ')': [')', 1],
    '[': [']', -1],
    ']': [']', 1],
    '{': ['}', -1],
    '}': ['}', 1],
};

function trimToken(raw: string): { endOffset: number; startOffset: number; text: string } {
    let startOffset = 0;
    let endOffset = raw.length;
    while (startOffset < endOffset && LEADING_WRAPPERS.has(raw[startOffset])) startOffset += 1;
    const bracketExcess: Record<ClosingBracket, number> = { ')': 0, ']': 0, '}': 0 };
    /**
     * Count each bracket once so a maximal token with many trailing closers stays linear.
     */
    for (let index = startOffset; index < endOffset; index += 1) {
        const adjustment = BRACKET_EXCESS_ADJUSTMENTS[raw[index]];
        if (adjustment) {
            const [closer, delta] = adjustment;
            bracketExcess[closer] += delta;
        }
    }
    while (startOffset < endOffset) {
        const last = raw[endOffset - 1];
        if (TRAILING_PUNCTUATION.has(last)) {
            endOffset -= 1;
            continue;
        }
        const closing = closingBracket(last);
        if (closing && bracketExcess[closing] > 0) {
            bracketExcess[closing] -= 1;
            endOffset -= 1;
            continue;
        }
        break;
    }
    return { endOffset, startOffset, text: raw.slice(startOffset, endOffset) };
}

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
function unsupportedHomeRanges(text: string): Array<{ endIndex: number; startIndex: number }> {
    return Array.from(text.matchAll(/(?:~[^/\s]+|\$(?:HOME|\{HOME\}))\/\S*/gu), (match) => ({
        endIndex: match.index + match[0].length,
        startIndex: match.index,
    }));
}

function isLikelyFilePath(path: string): boolean {
    if (isCurrentUserHomePath(path)) return true;
    if (isUnsupportedHomePath(path)) return false;
    if (/^file:\/\//i.test(path)) return true;
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return false;
    if (path.startsWith('/') || path.startsWith('./') || path.startsWith('../')) return true;
    if (path.includes('/')) return !path.startsWith('-');
    return /^[^/:]+\.[a-z\d][\w-]{0,15}$/i.test(path);
}

function locationPathStart(text: string, pathEnd: number, wordSeparators: string): number {
    let start = pathEnd;
    while (start > 0) {
        const character = text[start - 1];
        if (/[\s|<>"'`]/.test(character)) break;
        start -= 1;
    }
    const unmatchedOpeners: Array<{ closer: ClosingBracket; index: number }> = [];
    for (let index = start; index < pathEnd; index += 1) {
        const adjustment = BRACKET_EXCESS_ADJUSTMENTS[text[index]];
        if (!adjustment) continue;
        const [closer, delta] = adjustment;
        if (delta < 0) unmatchedOpeners.push({ closer, index });
        else if (unmatchedOpeners.at(-1)?.closer === closer) unmatchedOpeners.pop();
    }
    const opener = unmatchedOpeners.at(-1);
    const wrapperStart = opener ? opener.index + 1 : start;
    return detachPathCandidateFromCjkProse(
        { index: wrapperStart, text: text.slice(wrapperStart, pathEnd) },
        wordSeparators,
    ).index;
}

/**
 * Parses location-suffixed paths before fallback word tokenization, following VS Code's local-link detector. This keeps
 * balanced framework segments such as `(group)` and `[parameter]` inside the candidate while sentence punctuation stays
 * outside it. Server still validates the resolved path when the link activates.
 *
 * @see https://github.com/microsoft/vscode/blob/342c6c56db0bdb21397e4d553bfd52e35b8c9daf/src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkParsing.ts#L208-L222
 */
function findLocationFileLinks(
    text: string,
    urlLinks: TerminalLinkMatch[],
    wordSeparators: string,
): TerminalLinkMatch[] {
    const links: TerminalLinkMatch[] = [];
    let urlIndex = 0;
    for (const suffix of text.matchAll(TERMINAL_FILE_LOCATION_SUFFIX_PATTERN)) {
        const endIndex = suffix.index + suffix[0].length;
        const startIndex = locationPathStart(text, suffix.index, wordSeparators);
        const trimmed = trimToken(text.slice(startIndex, endIndex));
        const location = parseTerminalFileLocation(trimmed.text);
        if (!location.location || location.invalidLocation || !isLikelyFilePath(location.target))
            continue;
        const matchStart = startIndex + trimmed.startOffset;
        const matchEnd = startIndex + trimmed.endOffset;
        while (urlLinks[urlIndex]?.endIndex <= matchStart) urlIndex += 1;
        const url = urlLinks.at(urlIndex);
        if (url && matchStart < url.endIndex && matchEnd > url.startIndex) continue;
        links.push({
            ...location,
            endIndex: matchEnd,
            kind: 'file',
            startIndex: matchStart,
            text: trimmed.text,
        });
    }
    return links;
}

interface RawToken {
    index: number;
    text: string;
}

/**
 * Merges the URL and file passes without re-sorting their already ordered results.
 */
function mergeTerminalLinks(
    urls: TerminalLinkMatch[],
    files: TerminalLinkMatch[],
): TerminalLinkMatch[] {
    const links: TerminalLinkMatch[] = [];
    let urlIndex = 0;
    let fileIndex = 0;
    while (urlIndex < urls.length || fileIndex < files.length) {
        const url = urls.at(urlIndex);
        const file = files.at(fileIndex);
        if (url && (!file || url.startIndex <= file.startIndex)) {
            links.push(url);
            urlIndex += 1;
        } else if (file) {
            links.push(file);
            fileIndex += 1;
        }
    }
    return links;
}

/**
 * Splits rendered text into file-path candidates at whitespace and every configured separator, the way VS Code's
 * word-link detection consumes `terminal.integrated.wordSeparators`. Splitting (not trimming) is what detaches a path
 * from glued prose such as `串联 (src/api/x.ts)` — the CJK prefix is not a wrapper character, so wrapper trimming alone
 * can never remove it.
 */
function tokenizeByWordSeparators(text: string, wordSeparators: string): RawToken[] {
    const tokens: RawToken[] = [];
    let start = -1;
    for (let index = 0; index <= text.length; index += 1) {
        const character = index < text.length ? text[index] : ' ';
        const isSeparator = wordSeparators.includes(character) || /\s/.test(character);
        if (!isSeparator) {
            if (start === -1) start = index;
            continue;
        }
        if (start !== -1) tokens.push({ index: start, text: text.slice(start, index) });
        start = -1;
    }
    return tokens;
}

/**
 * Detaches a path suffix from CJK prose only when the suffix has an explicit path marker. Bare Project-relative paths
 * remain ambiguous (`目录。version/file.ts` may be one valid path), so treating every CJK punctuation mark as a separator
 * would corrupt them. The implicit boundaries apply only to the default setting; custom word separators retain exact
 * control over tokenization.
 */
function detachPathCandidateFromCjkProse(token: RawToken, wordSeparators: string): RawToken {
    if (wordSeparators !== TERMINAL_DEFAULT_WORD_SEPARATORS) return token;
    const firstSlash = token.text.indexOf('/');
    const searchStart = (firstSlash === -1 ? token.text.length : firstSlash) - 1;
    for (let index = searchStart; index >= 0; index -= 1) {
        if (!CJK_PROSE_BOUNDARIES.has(token.text[index])) continue;
        const candidate = token.text.slice(index + 1);
        const trimmed = trimToken(candidate);
        if (
            !trimmed.text.startsWith('.') &&
            !trimmed.text.startsWith('/') &&
            !/^file:\/\//i.test(trimmed.text)
        )
            return token;
        if (!trimmed.text || !isLikelyFilePath(parseTerminalFileLocation(trimmed.text).target))
            return token;
        return { index: token.index + index + 1, text: candidate };
    }
    return token;
}

/**
 * Extracts bounded URL and file candidates from rendered text without surrounding prose.
 */
export function findTerminalLinks(
    text: string,
    wordSeparators: string = TERMINAL_DEFAULT_WORD_SEPARATORS,
    metrics?: TerminalLinkScanMetrics,
    urlPattern: RegExp = PLAIN_TEXT_URL_PATTERN,
): TerminalLinkMatch[] {
    const wordFileLinks: TerminalLinkMatch[] = [];
    const urlLinks: TerminalLinkMatch[] = [];
    const unsupportedHomes = unsupportedHomeRanges(text);
    let urlLinkIndex = 0;
    let unsupportedHomeIndex = 0;
    for (const url of text.matchAll(urlPattern)) {
        const raw = url[0];
        const rawStart = url.index;
        const trimmed = trimToken(raw);
        if (!trimmed.text) continue;
        urlLinks.push({
            endIndex: rawStart + trimmed.endOffset,
            kind: 'url',
            startIndex: rawStart + trimmed.startOffset,
            target: trimmed.text,
            text: trimmed.text,
        });
    }
    const locationFileLinks = findLocationFileLinks(text, urlLinks, wordSeparators);
    let locationLinkIndex = 0;
    for (const rawToken of tokenizeByWordSeparators(text, wordSeparators)) {
        const token = detachPathCandidateFromCjkProse(rawToken, wordSeparators);
        const raw = token.text;
        const rawStart = token.index;
        const trimmed = trimToken(raw);
        if (!trimmed.text) continue;
        const startIndex = rawStart + trimmed.startOffset;
        const endIndex = rawStart + trimmed.endOffset;
        while (urlLinks[urlLinkIndex]?.endIndex <= startIndex) {
            if (metrics) metrics.detectedLinkRangeVisits += 1;
            urlLinkIndex += 1;
        }
        const urlLink = urlLinks.at(urlLinkIndex);
        if (urlLink) {
            if (metrics) metrics.detectedLinkRangeVisits += 1;
            if (startIndex < urlLink.endIndex && endIndex > urlLink.startIndex) continue;
        }
        /**
         * Both collections follow source order. Retire each completed range once, then compare the current token with
         * at most the next range instead of restarting from the first range.
         */
        while (unsupportedHomes[unsupportedHomeIndex]?.endIndex <= startIndex) {
            if (metrics) metrics.unsupportedHomeRangeVisits += 1;
            unsupportedHomeIndex += 1;
        }
        const unsupportedHome = unsupportedHomes.at(unsupportedHomeIndex);
        if (unsupportedHome) {
            if (metrics) metrics.unsupportedHomeRangeVisits += 1;
            if (startIndex < unsupportedHome.endIndex && endIndex > unsupportedHome.startIndex)
                continue;
        }
        const location = parseTerminalFileLocation(trimmed.text);
        if (location.invalidLocation || !isLikelyFilePath(location.target)) continue;
        while (locationFileLinks[locationLinkIndex]?.endIndex <= startIndex) locationLinkIndex += 1;
        const locationLink = locationFileLinks.at(locationLinkIndex);
        if (
            locationLink &&
            startIndex < locationLink.endIndex &&
            endIndex > locationLink.startIndex
        )
            continue;
        wordFileLinks.push({
            ...location,
            endIndex,
            kind: 'file',
            startIndex,
            text: trimmed.text,
        });
    }
    return mergeTerminalLinks(urlLinks, mergeTerminalLinks(locationFileLinks, wordFileLinks));
}

/**
 * Matches VS Code/iTerm2: a link only activates while the platform's "open" modifier is held, instead of on a bare
 * click. Caxri ships only on macOS (Cmd); Ctrl is also accepted so an external/non-Mac keyboard layout still works
 * without per-platform detection.
 */
function hasLinkActivationModifier(event: MouseEvent): boolean {
    return event.metaKey || event.ctrlKey;
}

/**
 * The single authority-neutral activation path shared by pointer links and the keyboard picker. Every branch delegates
 * to the existing typed callback, so discovering a link never grants the Renderer another filesystem or URL route.
 */
function activateLink(match: TerminalLinkMatch, context: TerminalLinkContext): void {
    if (match.kind === 'url') {
        context.openUrl(match.target);
        return;
    }
    context.openFile(match.target, match.location);
}

function activateLinkFromPointer(
    event: MouseEvent,
    match: TerminalLinkMatch,
    context: TerminalLinkContext,
): void {
    if (hasLinkActivationModifier(event)) activateLink(match, context);
}

export function createDetectedLink(
    match: TerminalLinkMatch,
    context: TerminalLinkContext,
    id: string,
    bufferLine: number,
): TerminalDetectedLink {
    return {
        accessibleName: `Open ${match.kind === 'url' ? 'external' : 'file'} link ${match.text}`,
        bufferLine,
        id,
        kind: match.kind,
        target: match.text,
        activate: () => activateLink(match, context),
    };
}

/**
 * Reconstructs the explicit physical newline emitted by Codex only when both path fragments carry enough syntax to
 * distinguish them from ordinary adjacent lines. The complete candidate still goes through the existing parser here and
 * the trusted Project-rooted resolver when activated.
 */
export function joinCodexHardWrappedFileLink(
    firstText: string,
    continuationText: string,
    wordSeparators: string = TERMINAL_DEFAULT_WORD_SEPARATORS,
): { continuationOffset: number; text: string } | undefined {
    if (firstText.length + continuationText.length > MAX_LOGICAL_LINE_LENGTH) return;
    const continuation = /^([ \t]{2,8})(\S+)$/u.exec(continuationText);
    if (!continuation) return;
    const continuationTarget = continuation[2];
    if (/^(?:\/|\.\.?\/|~\/|[a-z][a-z\d+.-]*:\/\/)/iu.test(continuationTarget)) return;

    const firstMatch = findTerminalLinks(firstText, wordSeparators).at(-1);
    if (
        firstMatch?.kind !== 'file' ||
        firstMatch.endIndex !== firstText.length ||
        firstMatch.location
    )
        return;
    const finalSegment = firstMatch.target.slice(firstMatch.target.lastIndexOf('/') + 1);
    if (/\.[a-z\d][\w-]{0,15}$/iu.test(finalSegment)) return;

    const text = firstText + continuationTarget;
    const joinedMatch = findTerminalLinks(text, wordSeparators).at(-1);
    if (
        joinedMatch?.kind !== 'file' ||
        joinedMatch.startIndex !== firstMatch.startIndex ||
        joinedMatch.endIndex !== text.length
    )
        return;
    return { continuationOffset: continuation[1].length, text };
}

/**
 * Rebuilds one bounded Terminal link line from xterm soft wraps and conservatively verified Codex hard wraps. Every
 * call reads current buffer state, so resize/reflow cannot retain stale ranges.
 */
export function readLogicalLine(
    terminal: Terminal,
    bufferLineNumber: number,
    wordSeparators: string = TERMINAL_DEFAULT_WORD_SEPARATORS,
): TerminalLogicalLine | undefined {
    let logicalLine = readSoftWrappedLogicalLine(terminal, bufferLineNumber);
    if (!logicalLine) return;
    while (logicalLine.firstBufferLine > 0) {
        const previous = readSoftWrappedLogicalLine(terminal, logicalLine.firstBufferLine);
        if (
            !previous ||
            logicalLine.lastBufferLine - previous.firstBufferLine + 1 > MAX_LOGICAL_LINE_ROWS
        )
            break;
        const joined = joinCodexHardWrappedFileLink(
            previous.text,
            logicalLine.text,
            wordSeparators,
        );
        if (!joined) break;
        logicalLine = joinTerminalLogicalLines(previous, logicalLine, joined.continuationOffset);
    }
    const buffer = terminal.buffer.active;
    while (logicalLine.lastBufferLine + 1 < buffer.length) {
        const next = readSoftWrappedLogicalLine(terminal, logicalLine.lastBufferLine + 2);
        if (!next || next.lastBufferLine - logicalLine.firstBufferLine + 1 > MAX_LOGICAL_LINE_ROWS)
            break;
        const joined = joinCodexHardWrappedFileLink(logicalLine.text, next.text, wordSeparators);
        if (!joined) break;
        logicalLine = joinTerminalLogicalLines(logicalLine, next, joined.continuationOffset);
    }
    return logicalLine;
}

/**
 * The label shown on hover, spelled out with the platform key so a user does not have to guess which modifier
 * `hasLinkActivationModifier` requires before a bare click will do anything.
 */
const TERMINAL_LINK_HINT_TEXT = '⌘ click to open';

/**
 * Pure placement math kept separate from the DOM write below so it can be unit tested without a browser environment.
 * Offsets the hint above and to the right of the pointer, matching the `Tooltip` component's `sideOffset`.
 */
export function terminalLinkHintPosition(event: { clientX: number; clientY: number }): {
    left: number;
    top: number;
} {
    return { left: event.clientX + 12, top: event.clientY - 28 };
}

/**
 * Creates the single hover-hint element lazily inside `terminal.element`, per xterm's own `ILinkHandler.hover`
 * guidance: an element with the `xterm-hover` class keeps mouse events from falling through onto neighboring links
 * while the hint is visible.
 */
function createLinkHintController(terminal: Terminal): {
    dispose(): void;
    hide(): void;
    show(event: MouseEvent): void;
} {
    let element: HTMLDivElement | undefined;
    return {
        show(event) {
            const host = terminal.element;
            if (!host) return;
            if (!element) {
                element = document.createElement('div');
                element.className =
                    'xterm-hover terminal-link-hint pointer-events-none fixed z-[90] rounded-md bg-elevated px-2.5 py-1.5 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]';
                element.textContent = TERMINAL_LINK_HINT_TEXT;
                element.setAttribute('role', 'tooltip');
                host.append(element);
            }
            const { left, top } = terminalLinkHintPosition(event);
            element.style.left = `${left}px`;
            element.style.top = `${top}px`;
        },
        hide() {
            element?.remove();
            element = undefined;
        },
        dispose() {
            element?.remove();
            element = undefined;
        },
    };
}

function linksForLogicalLine(
    logicalLine: TerminalLogicalLine,
    context: TerminalLinkContext,
    hint: ReturnType<typeof createLinkHintController>,
): ILink[] {
    return findTerminalLinks(logicalLine.text, context.wordSeparators).flatMap((match) => {
        // `.at()` (rather than `[index]`) keeps an out-of-range index's `undefined` case in the type, since this
        // project does not enable `noUncheckedIndexedAccess`.
        const start = logicalLine.positions.at(match.startIndex);
        const end = logicalLine.positions.at(match.endIndex - 1);
        if (!start || !end) return [];
        return [
            {
                activate: (event) => activateLinkFromPointer(event, match, context),
                /**
                 * The cursor/underline stay unconditional on hover rather than gated behind a live Cmd/Ctrl check:
                 * xterm only recomputes decorations when a link is (re)provided, so gating on the held modifier would
                 * need global keydown/keyup listeners forcing a fresh `provideLinks` pass (and a visible redraw) on
                 * every modifier press while the mouse sits still. The `hover` callback below instead shows a "⌘ click
                 * to open" tooltip, telling the user what a bare click cannot do without that churn — the same tradeoff
                 * VS Code's terminal makes for its link hover text.
                 */
                decorations: { pointerCursor: true, underline: true },
                hover: (event) => hint.show(event),
                leave: () => hint.hide(),
                range: { start, end },
                text: match.text,
            },
        ];
    });
}

function viewportPlainTextLinks(
    terminal: Terminal,
    context: TerminalLinkContext,
): TerminalDetectedLink[] {
    const buffer = terminal.buffer.active;
    const firstVisibleLine = buffer.viewportY;
    const lastVisibleLine = Math.min(buffer.length - 1, firstVisibleLine + terminal.rows - 1);
    const visitedLogicalLines = new Set<number>();
    const budget: TerminalDetectedLinkBudget = {
        links: [],
        targetBytes: 0,
        uniqueTargets: new Set(),
    };
    for (let line = firstVisibleLine; line <= lastVisibleLine; line += 1) {
        const logicalLine = readLogicalLine(terminal, line + 1, context.wordSeparators);
        if (!logicalLine || visitedLogicalLines.has(logicalLine.firstBufferLine)) continue;
        visitedLogicalLines.add(logicalLine.firstBufferLine);
        for (const match of findTerminalLinks(logicalLine.text, context.wordSeparators)) {
            const key = `${match.kind}:${match.text}`;
            const result = appendBoundedDetectedLink(budget, key, match.text, () =>
                createDetectedLink(
                    match,
                    context,
                    `plain:${logicalLine.firstBufferLine}:${match.startIndex}:${match.endIndex}`,
                    logicalLine.firstBufferLine,
                ),
            );
            if (result === 'exhausted') return budget.links;
        }
    }
    return budget.links;
}

function boundedDetectedLinks(
    candidates: Array<{
        bufferLine: number;
        key: string;
        target: string;
        link(): TerminalDetectedLink;
    }>,
): TerminalDetectedLink[] {
    const budget: TerminalDetectedLinkBudget = {
        links: [],
        targetBytes: 0,
        uniqueTargets: new Set(),
    };
    const orderedCandidates = candidates.toSorted(
        (left, right) => left.bufferLine - right.bufferLine,
    );
    for (const candidate of orderedCandidates) {
        const result = appendBoundedDetectedLink(budget, candidate.key, candidate.target, () =>
            candidate.link(),
        );
        if (result === 'exhausted') break;
    }
    return budget.links;
}

function exactTerminalLinkTarget(
    target: string,
    wordSeparators: string,
): TerminalLinkMatch | undefined {
    return findTerminalLinks(target, wordSeparators, undefined, EXPLICIT_TERMINAL_URL_PATTERN).find(
        (candidate) =>
            candidate.endIndex === target.length &&
            (candidate.startIndex === 0 ||
                CJK_PROSE_BOUNDARIES.has(target[candidate.startIndex - 1])),
    );
}

/**
 * Registers plain-text links and the OSC 8 handler through the same guarded activation path.
 */
export function registerTerminalLinks(
    terminal: Terminal,
    context: TerminalLinkContext,
): TerminalLinkRegistration {
    const hint = createLinkHintController(terminal);
    const disposable = terminal.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
            const logicalLine = readLogicalLine(terminal, bufferLineNumber, context.wordSeparators);
            const links = logicalLine ? linksForLogicalLine(logicalLine, context, hint) : [];
            callback(links.length > 0 ? links : undefined);
        },
    });
    terminal.options.linkHandler = {
        activate(event, text) {
            const match = exactTerminalLinkTarget(text, context.wordSeparators);
            if (match) activateLinkFromPointer(event, match, context);
        },
        /**
         * File URLs are allowed into the handler, then constrained by the Server-rooted read.
         */
        allowNonHttpProtocols: true,
    };
    const oscTracker = registerTerminalOscLinkTracker(terminal, (target) =>
        exactTerminalLinkTarget(target, context.wordSeparators),
    );
    return {
        getAllOscLinks: () => oscTracker.getAllLinks(),
        getViewportLinks() {
            const plain = viewportPlainTextLinks(terminal, context);
            return boundedDetectedLinks([
                ...plain.map((link) => ({
                    bufferLine: link.bufferLine,
                    key: `${link.kind}:${link.target}`,
                    target: link.target,
                    link: () => link,
                })),
                ...oscTracker.getViewportLinks().map(({ bufferLine, id, match }) => ({
                    bufferLine,
                    key: `${match.kind}:${match.text}`,
                    target: match.text,
                    link: () => createDetectedLink(match, context, id, bufferLine),
                })),
            ]);
        },
        restoreOscLinks: (snapshots) => oscTracker.restoreOscLinks(snapshots),
        dispose() {
            hint.dispose();
            terminal.options.linkHandler = null;
            disposable.dispose();
            oscTracker.dispose();
        },
    };
}
