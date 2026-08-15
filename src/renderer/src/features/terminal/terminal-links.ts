import type { IBufferCellPosition, IBufferLine, ILink, Terminal } from '@xterm/xterm';

const MAX_LOGICAL_LINE_ROWS = 16;
const MAX_LOGICAL_LINE_LENGTH = 16_384;
const LEADING_WRAPPERS = new Set(['(', '[', '{', '<', '"', "'", '`']);
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '"', "'", '`']);

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
    openFile(path: string, location?: { column: number; line: number }): void;
    openUrl(url: string): void;
}

type ClosingBracket = ')' | ']' | '}';

function closingBracket(value: string): ClosingBracket | undefined {
    return [')', ']', '}'].includes(value) ? (value as ClosingBracket) : undefined;
}

/**
 * Maps each opening/closing bracket character to the closer it affects and the amount by which it
 * shifts that closer's outstanding count, so `trimToken` can update `bracketExcess` without a
 * `switch`/`break` inside its loop.
 */
const BRACKET_EXCESS_ADJUSTMENTS: Record<string, readonly [ClosingBracket, number]> = {
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
    Count each bracket once so a maximal token with many trailing closers stays linear.
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
    if (!suffix || !suffix[1]) return { target: text };
    return {
        target: suffix[1],
        line: Number(suffix[2]),
        column: suffix[3] ? Number(suffix[3]) : 1,
    };
}

function isLikelyFilePath(path: string): boolean {
    if (/^file:\/\//i.test(path)) return true;
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return false;
    if (path.startsWith('/') || path.startsWith('./') || path.startsWith('../')) return true;
    if (path.includes('/')) return !path.startsWith('-');
    return /^[^/:]+\.[a-z\d][\w-]{0,15}$/i.test(path);
}

/**
Extracts bounded URL and file candidates from rendered text without surrounding prose.
 */
export function findTerminalLinks(text: string): TerminalLinkMatch[] {
    const links: TerminalLinkMatch[] = [];
    for (const url of text.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
        const raw = url[0];
        const rawStart = url.index ?? 0;
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
    for (const token of text.matchAll(/\S+/gu)) {
        const raw = token[0];
        const rawStart = token.index ?? 0;
        const trimmed = trimToken(raw);
        if (!trimmed.text) continue;
        const startIndex = rawStart + trimmed.startOffset;
        const endIndex = rawStart + trimmed.endOffset;
        if (links.some((link) => startIndex < link.endIndex && endIndex > link.startIndex))
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
    return links.toSorted((left, right) => left.startIndex - right.startIndex);
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
Resolves lexical POSIX paths; Runtime still owns canonical root and symlink validation.
 */
export function resolveTerminalFilePath(
    target: string,
    { cwd, projectRoot }: Pick<TerminalLinkContext, 'cwd' | 'projectRoot'>,
): string | undefined {
    const filePath = /^file:\/\//i.test(target) ? fileUrlPath(target) : target;
    if (!filePath) return;
    if (filePath.startsWith('/')) return normalizeAbsolutePath(filePath);
    const base = filePath.startsWith('./') || filePath.startsWith('../') ? cwd : projectRoot;
    return normalizeAbsolutePath(`${base}/${filePath}`);
}

/**
 * Matches VS Code/iTerm2: a link only activates while the platform's "open" modifier is held,
 * instead of on a bare click. Caxri ships only on macOS (Cmd); Ctrl is also accepted so an
 * external/non-Mac keyboard layout still works without per-platform detection.
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
    const path = resolveTerminalFilePath(match.target, context);
    if (!path) return;
    const location = match.line
        ? { line: Math.max(1, match.line), column: Math.max(1, match.column ?? 1) }
        : undefined;
    context.openFile(path, location);
}

interface LogicalLine {
    positions: IBufferCellPosition[];
    text: string;
}

/**
 * Rebuilds one bounded wrapped line and maps UTF-16 offsets back to xterm cells. CJK and emoji
 * before a link occupy a different number of terminal cells than JavaScript code units.
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
 * Walks one buffer row's cells and pushes one logical-text position per UTF-16 code unit, skipping
 * zero-width cells (the trailing half of a wide glyph). Extracted from `readLogicalLine` so the
 * per-cell skip only needs a `return`, not a `continue` reaching an outer loop.
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
 * The label shown on hover, spelled out with the platform key so a user does not have to guess
 * which modifier `hasLinkActivationModifier` requires before a bare click will do anything.
 */
const TERMINAL_LINK_HINT_TEXT = '⌘ click to open';

/**
 * Pure placement math kept separate from the DOM write below so it can be unit tested without a
 * browser environment. Offsets the hint above and to the right of the pointer, matching the
 * `Tooltip` component's `sideOffset`.
 */
export function terminalLinkHintPosition(event: { clientX: number; clientY: number }): {
    left: number;
    top: number;
} {
    return { left: event.clientX + 12, top: event.clientY - 28 };
}

/**
 * Creates the single hover-hint element lazily inside `terminal.element`, per xterm's own
 * `ILinkHandler.hover` guidance: an element with the `xterm-hover` class keeps mouse events from
 * falling through onto neighboring links while the hint is visible.
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
    return findTerminalLinks(logicalLine.text).flatMap((match) => {
        const start = logicalLine.positions[match.startIndex];
        const end = logicalLine.positions[match.endIndex - 1];
        if (!start || !end) return [];
        return [
            {
                activate: (event) => activateLink(event, match, context),
                /**
                 * The cursor/underline stay unconditional on hover rather than gated behind a live
                 * Cmd/Ctrl check: xterm only recomputes decorations when a link is (re)provided, so
                 * gating on the held modifier would need global keydown/keyup listeners forcing a
                 * fresh `provideLinks` pass (and a visible redraw) on every modifier press while the
                 * mouse sits still. The `hover` callback below instead shows a "⌘ click to open"
                 * tooltip, telling the user what a bare click cannot do without that churn — the
                 * same tradeoff VS Code's terminal makes for its link hover text.
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
Registers plain-text links and the OSC 8 handler through the same guarded activation path.
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
            const match = findTerminalLinks(text).find(
                (candidate) => candidate.startIndex === 0 && candidate.endIndex === text.length,
            );
            if (match) activateLink(event, match, context);
        },
        /**
        File URLs are allowed into the handler, then constrained by the Runtime-rooted read.
         */
        allowNonHttpProtocols: true,
    };
    return () => {
        hint.dispose();
        terminal.options.linkHandler = null;
        disposable.dispose();
    };
}
