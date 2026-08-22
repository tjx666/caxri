import type { IBufferCellPosition, IBufferLine, ILink, Terminal } from '@xterm/xterm';
import { sortBy } from 'es-toolkit';

const MAX_LOGICAL_LINE_ROWS = 16;
const MAX_LOGICAL_LINE_LENGTH = 16_384;
const CJK_PROSE_BOUNDARIES = new Set(['、', '，', '。', '；', '：', '！', '？']);
const LEADING_WRAPPERS = new Set(['(', '[', '{', '<', '"', "'", '`']);
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '"', "'", '`']);

/**
 * Matches the VS Code `terminal.integrated.wordSeparators` default (leading space included). The
 * `terminal.wordSeparators` setting overrides it; this constant is only the not-yet-loaded fallback.
 */
export const TERMINAL_DEFAULT_WORD_SEPARATORS = ' ()[]{}\',"`─‘’“”|';

export interface TerminalLinkMatch {
    endIndex: number;
    kind: 'file' | 'url';
    startIndex: number;
    target: string;
    text: string;
    column?: number;
    line?: number;
}

export interface TerminalLinkContext {
    cwd: string;
    projectRoot: string;
    wordSeparators: string;
    openFile(path: string, location?: { column: number; line: number }): void;
    openHomeFile(target: string, location?: { column: number; line: number }): void;
    openUrl(url: string): void;
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

function parseFileLocation(text: string): {
    column?: number;
    line?: number;
    target: string;
} {
    const suffix = /^(.*?):(\d+)(?::(\d+))?$/.exec(text);
    if (!suffix?.[1]) return { target: text };
    return {
        target: suffix[1],
        line: Number(suffix[2]),
        column: suffix[3] ? Number(suffix[3]) : 1,
    };
}

/**
 * Only the current user's exact `~/...` shorthand is actionable. Runtime owns OS user lookup and deliberately rejects
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

interface RawToken {
    index: number;
    text: string;
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
        if (!trimmed.text || !isLikelyFilePath(parseFileLocation(trimmed.text).target))
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
): TerminalLinkMatch[] {
    const links: TerminalLinkMatch[] = [];
    const unsupportedHomes = unsupportedHomeRanges(text);
    for (const url of text.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
        const raw = url[0];
        const rawStart = url.index;
        const trimmed = trimToken(raw);
        if (!trimmed.text) continue;
        links.push({
            endIndex: rawStart + trimmed.endOffset,
            kind: 'url',
            startIndex: rawStart + trimmed.startOffset,
            target: trimmed.text,
            text: trimmed.text,
        });
    }
    for (const rawToken of tokenizeByWordSeparators(text, wordSeparators)) {
        const token = detachPathCandidateFromCjkProse(rawToken, wordSeparators);
        const raw = token.text;
        const rawStart = token.index;
        const trimmed = trimToken(raw);
        if (!trimmed.text) continue;
        const startIndex = rawStart + trimmed.startOffset;
        const endIndex = rawStart + trimmed.endOffset;
        if (links.some((link) => startIndex < link.endIndex && endIndex > link.startIndex))
            continue;
        if (
            unsupportedHomes.some(
                (range) => startIndex < range.endIndex && endIndex > range.startIndex,
            )
        )
            continue;
        const location = parseFileLocation(trimmed.text);
        if (!isLikelyFilePath(location.target)) continue;
        links.push({
            ...location,
            endIndex,
            kind: 'file',
            startIndex,
            text: trimmed.text,
        });
    }
    return sortBy(links, ['startIndex']);
}

function normalizeAbsolutePath(path: string): string {
    const segments: string[] = [];
    for (const segment of path.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') segments.pop();
        else segments.push(segment);
    }
    return `/${segments.join('/')}`;
}

function fileUrlPath(target: string): string | undefined {
    try {
        const url = new URL(target);
        if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return;
        return decodeURIComponent(url.pathname);
    } catch {
        return;
    }
}

/**
 * Resolves lexical POSIX paths; Runtime still owns canonical root and symlink validation.
 */
export function resolveTerminalFilePath(
    target: string,
    { cwd, projectRoot }: Pick<TerminalLinkContext, 'cwd' | 'projectRoot'>,
): string | undefined {
    const filePath = /^file:\/\//i.test(target) ? fileUrlPath(target) : target;
    if (!filePath || isCurrentUserHomePath(filePath) || isUnsupportedHomePath(filePath)) return;
    if (filePath.startsWith('/')) return normalizeAbsolutePath(filePath);
    const base = filePath.startsWith('./') || filePath.startsWith('../') ? cwd : projectRoot;
    return normalizeAbsolutePath(`${base}/${filePath}`);
}

/**
 * Matches VS Code/iTerm2: a link only activates while the platform's "open" modifier is held, instead of on a bare
 * click. Caxri ships only on macOS (Cmd); Ctrl is also accepted so an external/non-Mac keyboard layout still works
 * without per-platform detection.
 */
function hasLinkActivationModifier(event: MouseEvent): boolean {
    return event.metaKey || event.ctrlKey;
}

function activateLink(
    event: MouseEvent,
    match: TerminalLinkMatch,
    context: TerminalLinkContext,
): void {
    if (!hasLinkActivationModifier(event)) return;
    if (match.kind === 'url') {
        context.openUrl(match.target);
        return;
    }
    const location = match.line
        ? { line: Math.max(1, match.line), column: Math.max(1, match.column ?? 1) }
        : undefined;
    if (isCurrentUserHomePath(match.target)) {
        context.openHomeFile(match.target, location);
        return;
    }
    const path = resolveTerminalFilePath(match.target, context);
    if (!path) return;
    context.openFile(path, location);
}

interface LogicalLine {
    positions: IBufferCellPosition[];
    text: string;
}

/**
 * Rebuilds one bounded wrapped line and maps UTF-16 offsets back to xterm cells. CJK and emoji before a link occupy a
 * different number of terminal cells than JavaScript code units.
 */
function readLogicalLine(terminal: Terminal, bufferLineNumber: number): LogicalLine | undefined {
    const buffer = terminal.buffer.active;
    const requested = bufferLineNumber - 1;
    if (requested < 0 || requested >= buffer.length) return;
    let first = requested;
    let rowCount = 1;
    while (first > 0 && buffer.getLine(first)?.isWrapped && rowCount < MAX_LOGICAL_LINE_ROWS) {
        first -= 1;
        rowCount += 1;
    }
    let last = requested;
    while (
        last + 1 < buffer.length &&
        buffer.getLine(last + 1)?.isWrapped &&
        last - first + 1 < MAX_LOGICAL_LINE_ROWS
    )
        last += 1;

    let text = '';
    const positions: IBufferCellPosition[] = [];
    for (let y = first; y <= last && text.length < MAX_LOGICAL_LINE_LENGTH; y += 1) {
        const line = buffer.getLine(y);
        if (!line) break;
        const lineText = line.translateToString(true);
        appendLineCellPositions(line, y, lineText, terminal.cols, positions);
        text += lineText.slice(0, Math.min(lineText.length, MAX_LOGICAL_LINE_LENGTH - text.length));
    }
    return { positions, text };
}

/**
 * Walks one buffer row's cells and pushes one logical-text position per UTF-16 code unit, skipping zero-width cells
 * (the trailing half of a wide glyph). Extracted from `readLogicalLine` so the per-cell skip only needs a `return`, not
 * a `continue` reaching an outer loop.
 */
function appendLineCellPositions(
    line: IBufferLine,
    y: number,
    lineText: string,
    columns: number,
    positions: IBufferCellPosition[],
): void {
    let offset = 0;
    for (let x = 0; x < Math.min(line.length, columns) && offset < lineText.length; x += 1) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ';
        for (let index = 0; index < chars.length && offset < lineText.length; index += 1) {
            positions.push({ x: x + 1, y: y + 1 });
            offset += 1;
        }
    }
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
    logicalLine: LogicalLine,
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
                activate: (event) => activateLink(event, match, context),
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

/**
 * Registers plain-text links and the OSC 8 handler through the same guarded activation path.
 */
export function registerTerminalLinks(
    terminal: Terminal,
    context: TerminalLinkContext,
): () => void {
    const hint = createLinkHintController(terminal);
    const disposable = terminal.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
            const logicalLine = readLogicalLine(terminal, bufferLineNumber);
            const links = logicalLine ? linksForLogicalLine(logicalLine, context, hint) : [];
            callback(links.length > 0 ? links : undefined);
        },
    });
    terminal.options.linkHandler = {
        activate(event, text) {
            const match = findTerminalLinks(text, context.wordSeparators).find(
                (candidate) =>
                    candidate.endIndex === text.length &&
                    (candidate.startIndex === 0 ||
                        CJK_PROSE_BOUNDARIES.has(text[candidate.startIndex - 1])),
            );
            if (match) activateLink(event, match, context);
        },
        /**
         * File URLs are allowed into the handler, then constrained by the Runtime-rooted read.
         */
        allowNonHttpProtocols: true,
    };
    return () => {
        hint.dispose();
        terminal.options.linkHandler = null;
        disposable.dispose();
    };
}
