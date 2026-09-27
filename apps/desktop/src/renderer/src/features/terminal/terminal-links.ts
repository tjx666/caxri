import type { EditorNavigationTarget, TerminalOscLinkSnapshot } from '@caxri/protocol';
import type { ILink, Terminal } from '@xterm/xterm';

import type { RawToken } from './terminal-file-candidate';
import {
    CJK_PROSE_BOUNDARIES,
    detachPathCandidateFromCjkProse,
    enumeratedPathCandidateStart,
    hasAmbiguousCjkProsePrefix,
    isLikelyFilePath,
    TERMINAL_DEFAULT_WORD_SEPARATORS,
    trailingCjkProseOffset,
    unsupportedHomeRanges,
} from './terminal-file-candidate';
import {
    parseTerminalFileLocation,
    TERMINAL_FILE_LOCATION_SUFFIX_PATTERN,
} from './terminal-file-location';
import type { TerminalLinkHintController, TerminalLinkHintPreview } from './terminal-link-hint';
import { createTerminalLinkHintController } from './terminal-link-hint';
import type { TerminalLinkClosingBracket } from './terminal-link-token';
import {
    TERMINAL_LINK_BRACKET_ADJUSTMENTS,
    trimPlainTextUrlToken,
    trimTerminalLinkToken,
} from './terminal-link-token';
import type { TerminalLogicalLine } from './terminal-logical-line';
import { joinTerminalLogicalLines, readSoftWrappedLogicalLine } from './terminal-logical-line';
import type { VisibleOscLink } from './terminal-osc-link-tracker';
import {
    MAX_TERMINAL_LINK_LENGTH as MAX_LOGICAL_LINE_LENGTH,
    MAX_TERMINAL_LINK_ROWS as MAX_LOGICAL_LINE_ROWS,
    registerTerminalOscLinkTracker,
} from './terminal-osc-link-tracker';
import { findQuotedPathLinks } from './terminal-quoted-path-links';
import type {
    TerminalLinkReferenceContext,
    TerminalReferenceMatch,
} from './terminal-reference-links';
import { findTerminalReferenceLinks } from './terminal-reference-links';

const EXPLICIT_TERMINAL_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
/**
 * Plain text needs explicit CJK prose boundaries while OSC 8 targets retain every valid Unicode URL character.
 */
const PLAIN_TEXT_URL_PATTERN = /https?:\/\/[^\s<>"'`、，。；：！？（）]+/giu;
const TERMINAL_FILE_LINK_HINT_TEXT = '⌘ click to open in editor';
const TERMINAL_URL_LINK_HINT_TEXT = '⌘ click to open in browser';

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
    accessibleName?: string;
    detail?: string;
    endIndex: number;
    hint?: string;
    /**
     * Set by `findTerminalReferenceLinks` on the declarative references that carry a hover preview card. See
     * {@link TerminalReferenceMatch}.
     */
    isReference?: boolean;
    kind: 'commit' | 'file' | 'url';
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
    referenceContext: TerminalLinkReferenceContext;
    wordSeparators: string;
    openCommit(reference: string): void;
    openFile(target: string, location?: EditorNavigationTarget): void;
    openUrl(url: string): void;
    /**
     * Builds the hover card for one reference. Optional so the link scanner and the unit tests can drive detection
     * without standing up a preview store; a context without it keeps the plain affordance hint.
     */
    previewReference?(match: TerminalLinkMatch): TerminalLinkHintPreview | undefined;
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

function locationPathStart(text: string, pathEnd: number, wordSeparators: string): number {
    let start = pathEnd;
    while (start > 0) {
        const character = text[start - 1];
        if (/[\s|<>"'`]/.test(character)) break;
        start -= 1;
    }
    const unmatchedOpeners: Array<{ closer: TerminalLinkClosingBracket; index: number }> = [];
    for (let index = start; index < pathEnd; index += 1) {
        const adjustment = TERMINAL_LINK_BRACKET_ADJUSTMENTS[text[index]];
        if (!adjustment) continue;
        const [closer, delta] = adjustment;
        if (delta < 0) unmatchedOpeners.push({ closer, index });
        else if (unmatchedOpeners.at(-1)?.closer === closer) unmatchedOpeners.pop();
    }
    const opener = unmatchedOpeners.at(-1);
    const wrapperStart = opener ? opener.index + 1 : start;
    const detached = detachPathCandidateFromCjkProse(
        { index: wrapperStart, text: text.slice(wrapperStart, pathEnd) },
        wordSeparators,
    );
    return detached.index + enumeratedPathCandidateStart(detached.text, wordSeparators);
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
        const trimmed = trimTerminalLinkToken(text.slice(startIndex, endIndex));
        const location = parseTerminalFileLocation(trimmed.text);
        if (
            !location.location ||
            location.invalidLocation ||
            !isLikelyFilePath(location.target) ||
            (wordSeparators === TERMINAL_DEFAULT_WORD_SEPARATORS &&
                hasAmbiguousCjkProsePrefix(location.target))
        )
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

/**
 * Drops candidates covered by an already accepted range. Both collections follow source order, so each range is retired
 * once instead of rescanning from the first one.
 */
function withoutCoveredLinks(
    links: TerminalLinkMatch[],
    ranges: TerminalLinkMatch[],
): TerminalLinkMatch[] {
    if (ranges.length === 0) return links;
    let rangeIndex = 0;
    return links.filter((link) => {
        while (ranges[rangeIndex]?.endIndex <= link.startIndex) rangeIndex += 1;
        const range = ranges.at(rangeIndex);
        return !(range && link.startIndex < range.endIndex && link.endIndex > range.startIndex);
    });
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
 * Extracts bounded URL and file candidates from rendered text without surrounding prose.
 */
export function findTerminalLinks(
    text: string,
    wordSeparators: string = TERMINAL_DEFAULT_WORD_SEPARATORS,
    metrics?: TerminalLinkScanMetrics,
    urlPattern: RegExp = PLAIN_TEXT_URL_PATTERN,
    referenceContext?: TerminalLinkReferenceContext,
): TerminalLinkMatch[] {
    const wordFileLinks: TerminalLinkMatch[] = [];
    const urlLinks: TerminalLinkMatch[] = [];
    const unsupportedHomes = unsupportedHomeRanges(text);
    let urlLinkIndex = 0;
    let unsupportedHomeIndex = 0;
    for (const url of text.matchAll(urlPattern)) {
        const raw = url[0];
        const rawStart = url.index;
        const trimmed =
            urlPattern === PLAIN_TEXT_URL_PATTERN
                ? trimPlainTextUrlToken(raw)
                : trimTerminalLinkToken(raw);
        if (!trimmed.text) continue;
        urlLinks.push({
            endIndex: rawStart + trimmed.endOffset,
            kind: 'url',
            startIndex: rawStart + trimmed.startOffset,
            target: trimmed.text,
            text: trimmed.text,
        });
    }
    const quotedPathLinks = findQuotedPathLinks(text, urlLinks, wordSeparators);
    const quotedExclusions = quotedPathLinks.excludedRanges;
    const locationFileLinks = withoutCoveredLinks(
        findLocationFileLinks(text, urlLinks, wordSeparators),
        quotedPathLinks.links,
    );
    let locationLinkIndex = 0;
    let quotedLinkIndex = 0;
    for (const rawToken of tokenizeByWordSeparators(text, wordSeparators)) {
        const token = detachPathCandidateFromCjkProse(rawToken, wordSeparators);
        const raw = token.text.slice(0, trailingCjkProseOffset(token.text, wordSeparators));
        const rawStart = token.index;
        const trimmed = trimTerminalLinkToken(raw);
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
        while (quotedExclusions[quotedLinkIndex]?.endIndex <= startIndex) quotedLinkIndex += 1;
        const exclusion = quotedExclusions.at(quotedLinkIndex);
        if (exclusion && startIndex < exclusion.endIndex && endIndex > exclusion.startIndex)
            continue;
        // Every reserved-range collection here follows source order, so each entry retires once instead of rescanning.
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
        if (
            location.invalidLocation ||
            !isLikelyFilePath(location.target) ||
            (wordSeparators === TERMINAL_DEFAULT_WORD_SEPARATORS &&
                hasAmbiguousCjkProsePrefix(location.target))
        )
            continue;
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
    const fileLinks = mergeTerminalLinks(
        quotedPathLinks.links,
        mergeTerminalLinks(locationFileLinks, wordFileLinks),
    );
    const references = referenceContext
        ? findTerminalReferenceLinks(text, referenceContext).filter(
              (reference) =>
                  urlLinks.every(
                      (url) =>
                          !(
                              reference.startIndex < url.endIndex &&
                              reference.endIndex > url.startIndex
                          ),
                  ) &&
                  (reference.overridesFile ||
                      fileLinks.every(
                          (file) =>
                              !(
                                  reference.startIndex < file.endIndex &&
                                  reference.endIndex > file.startIndex
                              ),
                      )),
          )
        : [];
    const unshadowedFiles = fileLinks.filter((file) =>
        references.every(
            (reference) =>
                !(reference.startIndex < file.endIndex && reference.endIndex > file.startIndex),
        ),
    );
    return mergeTerminalLinks(mergeTerminalLinks(urlLinks, references), unshadowedFiles);
}

/**
 * Matches VS Code/iTerm2: a link only activates while the platform's "open" modifier is held, instead of on a bare
 * click. Caxri ships only on macOS, where Ctrl+click is reserved for the secondary-click gesture.
 */
function hasLinkActivationModifier(event: MouseEvent): boolean {
    return event.metaKey;
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
    if (match.kind === 'commit') {
        context.openCommit(match.target);
        return;
    }
    context.openFile(match.target, match.location);
}

/**
 * Keeps a Cmd+click on a link from also reaching a foreground app that enabled mouse tracking. xterm's mouse report
 * drops `metaKey`, so an app such as Codex's fullscreen transcript sees a plain left click on the same link and opens
 * it a second time. Like iTerm2 and Ghostty, Caxri owns that click: xterm's Linkifier listens on `.xterm-screen` and
 * still activates the link, while stopping the bubble there keeps the event from xterm's mouse service on the enclosing
 * `.xterm` element, which never sends the press or arms its release listener. Every other click is still forwarded.
 */
function registerMouseTrackingLinkClickGuard(
    terminal: Terminal,
    hint: TerminalLinkHintController,
): () => void {
    const screen = terminal.screenElement;
    if (!screen) return () => {};
    const onMouseDown = (event: MouseEvent) => {
        if (
            event.button !== 0 ||
            !hasLinkActivationModifier(event) ||
            terminal.modes.mouseTrackingMode === 'none' ||
            !hint.isLinkHovered()
        )
            return;
        event.stopPropagation();
        // The skipped mouse service would have suppressed native selection and focused the Terminal.
        event.preventDefault();
        terminal.focus();
    };
    screen.addEventListener('mousedown', onMouseDown);
    return () => screen.removeEventListener('mousedown', onMouseDown);
}

function activateLinkFromPointer(
    event: MouseEvent,
    match: TerminalLinkMatch,
    context: TerminalLinkContext,
): void {
    if (hasLinkActivationModifier(event)) activateLink(match, context);
}

export function terminalLinkHintText(match: Pick<TerminalLinkMatch, 'hint' | 'kind'>): string {
    if (match.hint) return match.hint;
    return match.kind === 'url'
        ? TERMINAL_URL_LINK_HINT_TEXT
        : match.kind === 'commit'
          ? '⌘ click to show commit in Git'
          : TERMINAL_FILE_LINK_HINT_TEXT;
}

/**
 * Keeps xterm's synchronous leave/reprovide cycle stable without treating a different link rewritten at the same buffer
 * range as the old one. The target is part of the identity because Terminal applications commonly redraw a line in
 * place.
 */
export function terminalLinkHintKey(
    scope: string,
    match: Pick<TerminalLinkMatch, 'kind' | 'text'>,
): string {
    return `${scope}:${match.kind}:${match.text}`;
}

export function createDetectedLink(
    match: TerminalLinkMatch,
    context: TerminalLinkContext,
    id: string,
    bufferLine: number,
): TerminalDetectedLink {
    return {
        accessibleName:
            match.accessibleName ??
            `Open ${match.kind === 'url' ? 'external' : 'file'} link ${match.text}`,
        bufferLine,
        detail: match.detail,
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
 *
 * Codex wraps prose paragraphs the same way it wraps standalone paths, so the continuation row may carry more text
 * after the path fragment (` formatErrorForState.ts:79 又合入了上游原文`). That inline form is accepted only when the joined
 * target ends in a file extension or a line location, because an indented prose word glued onto a dangling path
 * (`/repo/one-` + `followed by prose`) would otherwise parse as a plausible extensionless file. The returned text is
 * the whole joined row so later links on the continuation row stay discoverable.
 */
export function joinCodexHardWrappedFileLink(
    firstText: string,
    continuationText: string,
    wordSeparators: string = TERMINAL_DEFAULT_WORD_SEPARATORS,
): { continuationOffset: number; text: string } | undefined {
    if (firstText.length + continuationText.length > MAX_LOGICAL_LINE_LENGTH) return;
    const continuation = /^([ \t]{2,8})(\S+)/u.exec(continuationText);
    if (!continuation) return;
    const continuationOffset = continuation[1].length;
    const continuationTarget = continuation[2];
    if (/^(?:\/|\.\.?\/|~\/|[a-z][a-z\d+.-]*:\/\/)/iu.test(continuationTarget)) return;

    const firstMatch = findTerminalLinks(firstText, wordSeparators).at(-1);
    if (
        firstMatch?.kind !== 'file' ||
        firstMatch.endIndex !== firstText.length ||
        firstMatch.location
    )
        return;
    if (hasFileExtension(firstMatch.target)) return;

    const text = firstText + continuationText.slice(continuationOffset);
    const joinedMatch = findTerminalLinks(text, wordSeparators).find(
        (match) => match.startIndex === firstMatch.startIndex,
    );
    if (
        joinedMatch?.kind !== 'file' ||
        joinedMatch.endIndex <= firstText.length ||
        joinedMatch.endIndex > firstText.length + continuationTarget.length
    )
        return;
    /**
     * A fragment that fills the rest of the row (the multi-row case) needs no further syntax; anything followed by more
     * text must prove it is a file reference rather than a prose word glued onto a dangling path.
     */
    if (
        joinedMatch.endIndex !== text.length &&
        !joinedMatch.location &&
        !hasFileExtension(joinedMatch.target)
    )
        return;
    return { continuationOffset, text };
}

function hasFileExtension(target: string): boolean {
    const finalSegment = target.slice(target.lastIndexOf('/') + 1);
    return /\.[a-z\d][\w-]{0,15}$/iu.test(finalSegment);
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

function linksForLogicalLine(
    logicalLine: TerminalLogicalLine,
    context: TerminalLinkContext,
    hint: TerminalLinkHintController,
): ILink[] {
    return findTerminalLinks(
        logicalLine.text,
        context.wordSeparators,
        undefined,
        undefined,
        context.referenceContext,
    ).flatMap((match) => {
        // `.at()` (rather than `[index]`) keeps an out-of-range index's `undefined` case in the type, since this
        // project does not enable `noUncheckedIndexedAccess`.
        const start = logicalLine.positions.at(match.startIndex);
        const end = logicalLine.positions.at(match.endIndex - 1);
        if (!start || !end) return [];
        const link: ILink = {
            activate: (event) => activateLinkFromPointer(event, match, context),
            /**
             * High-confidence links stay underlined, while the pointer follows the live Cmd state. The hover controller
             * waits until xterm installs its public decoration setters, then updates them without reproviding the
             * link.
             */
            decorations: { pointerCursor: false, underline: true },
            hover: (event) =>
                hint.show(
                    event,
                    terminalLinkHintText(match),
                    (isModifierDown) => {
                        if (link.decorations) link.decorations.pointerCursor = isModifierDown;
                    },
                    terminalLinkHintKey(
                        `plain:${logicalLine.firstBufferLine}:${match.startIndex}:${match.endIndex}`,
                        match,
                    ),
                    match.isReference ? context.previewReference?.(match) : undefined,
                ),
            leave: () => hint.leave(),
            range: { start, end },
            text: match.text,
        };
        return [link];
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
        for (const match of findTerminalLinks(
            logicalLine.text,
            context.wordSeparators,
            undefined,
            undefined,
            context.referenceContext,
        )) {
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
    const hint = createTerminalLinkHintController(terminal);
    const disposeMouseTrackingGuard = registerMouseTrackingLinkClickGuard(terminal, hint);
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
        hover(event, text, range) {
            const match = exactTerminalLinkTarget(text, context.wordSeparators);
            if (match)
                hint.show(
                    event,
                    terminalLinkHintText(match),
                    undefined,
                    terminalLinkHintKey(
                        `osc:${range.start.x}:${range.start.y}:${range.end.x}:${range.end.y}`,
                        match,
                    ),
                );
        },
        leave() {
            hint.leave();
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
            disposeMouseTrackingGuard();
            hint.dispose();
            terminal.options.linkHandler = null;
            disposable.dispose();
            oscTracker.dispose();
        },
    };
}
