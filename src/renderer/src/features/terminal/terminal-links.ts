import type { IBufferCellPosition, ILink, Terminal } from '@xterm/xterm';

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
    return value === ')' || value === ']' || value === '}' ? value : undefined;
}

function trimToken(raw: string): { endOffset: number; startOffset: number; text: string } {
    let startOffset = 0;
    let endOffset = raw.length;
    while (startOffset < endOffset && LEADING_WRAPPERS.has(raw[startOffset])) startOffset += 1;
    const bracketExcess: Record<ClosingBracket, number> = { ')': 0, ']': 0, '}': 0 };
    /** Count each bracket once so a maximal token with many trailing closers stays linear. */
    for (let index = startOffset; index < endOffset; index += 1) {
        const value = raw[index];
        if (value === '(') bracketExcess[')'] -= 1;
        else if (value === ')') bracketExcess[')'] += 1;
        else if (value === '[') bracketExcess[']'] -= 1;
        else if (value === ']') bracketExcess[']'] += 1;
        else if (value === '{') bracketExcess['}'] -= 1;
        else if (value === '}') bracketExcess['}'] += 1;
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
    const suffix = /^(.*?)(?::(\d+))(?::(\d+))?$/.exec(text);
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
    return /^\.?[^/:]+\.[a-z\d][a-z\d_-]{0,15}$/i.test(path);
}

/** Extracts bounded URL and file candidates from rendered text without surrounding prose. */
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
    return links.sort((left, right) => left.startIndex - right.startIndex);
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

/** Resolves lexical POSIX paths; Runtime still owns canonical root and symlink validation. */
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

function activateLink(match: TerminalLinkMatch, context: TerminalLinkContext): void {
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
        let offset = 0;
        for (
            let x = 0;
            x < Math.min(line.length, terminal.cols) && offset < lineText.length;
            x += 1
        ) {
            const cell = line.getCell(x);
            if (!cell || cell.getWidth() === 0) continue;
            const chars = cell.getChars() || ' ';
            for (let index = 0; index < chars.length && offset < lineText.length; index += 1) {
                positions.push({ x: x + 1, y: y + 1 });
                offset += 1;
            }
        }
        text += lineText.slice(0, Math.min(lineText.length, MAX_LOGICAL_LINE_LENGTH - text.length));
    }
    return { positions, text };
}

function linksForLogicalLine(logicalLine: LogicalLine, context: TerminalLinkContext): ILink[] {
    return findTerminalLinks(logicalLine.text).flatMap((match) => {
        const start = logicalLine.positions[match.startIndex];
        const end = logicalLine.positions[match.endIndex - 1];
        if (!start || !end) return [];
        return [
            {
                activate: () => activateLink(match, context),
                decorations: { pointerCursor: true, underline: true },
                range: { start, end },
                text: match.text,
            },
        ];
    });
}

/** Registers plain-text links and the OSC 8 handler through the same guarded activation path. */
export function registerTerminalLinks(
    terminal: Terminal,
    context: TerminalLinkContext,
): () => void {
    const disposable = terminal.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
            const logicalLine = readLogicalLine(terminal, bufferLineNumber);
            const links = logicalLine ? linksForLogicalLine(logicalLine, context) : [];
            callback(links.length > 0 ? links : undefined);
        },
    });
    terminal.options.linkHandler = {
        activate(_event, text) {
            const match = findTerminalLinks(text).find(
                (candidate) => candidate.startIndex === 0 && candidate.endIndex === text.length,
            );
            if (match) activateLink(match, context);
        },
        /** File URLs are allowed into the handler, then constrained by the Runtime-rooted read. */
        allowNonHttpProtocols: true,
    };
    return () => {
        terminal.options.linkHandler = null;
        disposable.dispose();
    };
}
