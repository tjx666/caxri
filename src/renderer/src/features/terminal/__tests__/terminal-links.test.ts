import type { ILink, ILinkProvider, IMarker, Terminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalLinkContext } from '../terminal-links';
import {
    findTerminalLinks,
    registerTerminalLinks,
    resolveTerminalFilePath,
    TERMINAL_DEFAULT_WORD_SEPARATORS,
    terminalLinkHintPosition,
} from '../terminal-links';
import { clearTerminalOscLinkSnapshots } from '../terminal-osc-link-tracker';

describe('findTerminalLinks', () => {
    it('extracts Markdown URLs after CJK text without including prose punctuation', () => {
        expect(findTerminalLinks('结果：[Issue](https://example.com/a_(b)).')).toEqual([
            {
                endIndex: 36,
                kind: 'url',
                startIndex: 11,
                target: 'https://example.com/a_(b)',
                text: 'https://example.com/a_(b)',
            },
        ]);
    });

    it('extracts absolute, Project-relative, and file URL locations', () => {
        expect(
            findTerminalLinks(
                'open /repo/src/a.ts:42:7, then src/b.test.ts:9 and file:///repo/c.ts',
            ),
        ).toMatchObject([
            { kind: 'file', target: '/repo/src/a.ts', line: 42, column: 7 },
            { kind: 'file', target: 'src/b.test.ts', line: 9, column: 1 },
            { kind: 'file', target: 'file:///repo/c.ts' },
        ]);
    });

    it('splits a path from glued CJK prose at a word-separator parenthesis', () => {
        // Regression: `realpath '/…/串联 (src/api/workflows/es-reindex.ts)'` ENOENT — the CJK
        // prefix and wrapping parentheses were folded into the clicked path.
        expect(findTerminalLinks('串联 (src/api/workflows/es-reindex.ts) 已完成')).toEqual([
            {
                endIndex: 35,
                kind: 'file',
                startIndex: 4,
                target: 'src/api/workflows/es-reindex.ts',
                text: 'src/api/workflows/es-reindex.ts',
            },
        ]);
        expect(findTerminalLinks('串联(src/api/workflows/es-reindex.ts)')).toEqual([
            {
                endIndex: 34,
                kind: 'file',
                startIndex: 3,
                target: 'src/api/workflows/es-reindex.ts',
                text: 'src/api/workflows/es-reindex.ts',
            },
        ]);
    });

    it.each(['。', '，', '：'])('splits a path from CJK prose after %s', (separator) => {
        const text = `说明${separator}.local-config/model-config/meta.json:4`;

        expect(findTerminalLinks(text)).toEqual([
            {
                column: 1,
                endIndex: text.length,
                kind: 'file',
                line: 4,
                startIndex: 3,
                target: '.local-config/model-config/meta.json',
                text: '.local-config/model-config/meta.json:4',
            },
        ]);
    });

    it('preserves CJK punctuation inside valid relative paths', () => {
        expect(findTerminalLinks('./目录。版本/file.ts:8')).toMatchObject([
            { kind: 'file', target: './目录。版本/file.ts', line: 8, column: 1 },
        ]);
        expect(findTerminalLinks('目录。版本/file.ts:8')).toMatchObject([
            { kind: 'file', target: '目录。版本/file.ts', line: 8, column: 1 },
        ]);
        expect(findTerminalLinks('目录。version/file.ts:8')).toMatchObject([
            { kind: 'file', target: '目录。version/file.ts', line: 8, column: 1 },
        ]);
        expect(findTerminalLinks('docs/中文说明.md')).toMatchObject([
            { kind: 'file', target: 'docs/中文说明.md' },
        ]);
    });

    it('honors custom word separators from the terminal.wordSeparators setting', () => {
        // With `(` removed from the separators the glued token stays one word (the pre-setting
        // behavior), and with `:` added the line suffix stops being parsed — mirroring VS Code's
        // documented caveat about putting `:` in `terminal.integrated.wordSeparators`.
        expect(findTerminalLinks('串联(src/api/x.ts)', ' ')).toMatchObject([
            { kind: 'file', target: '串联(src/api/x.ts)' },
        ]);
        expect(
            findTerminalLinks('说明。.local-config/model-config/meta.json:4', ' '),
        ).toMatchObject([
            {
                kind: 'file',
                target: '说明。.local-config/model-config/meta.json',
                line: 4,
                column: 1,
            },
        ]);
        const withColonSeparator = findTerminalLinks('src/a.ts:12', ' :');
        expect(withColonSeparator).toMatchObject([{ kind: 'file', target: 'src/a.ts' }]);
        expect(withColonSeparator[0]).not.toHaveProperty('line');
    });

    it('does not turn custom protocols, flags, or ordinary dotted prose into file links', () => {
        expect(findTerminalLinks('javascript:alert(1) --flag version.')).toEqual([]);
    });

    it('offers exact current-user Home paths without accepting other shell expansion forms', () => {
        expect(findTerminalLinks('config: ~/example/path.json:7')).toMatchObject([
            { kind: 'file', target: '~/example/path.json', line: 7, column: 1 },
        ]);
        expect(
            findTerminalLinks('~user/example.json $HOME/example.json ${HOME}/example.json'),
        ).toEqual([]);
        expect(
            findTerminalLinks('~user/example.json $HOME/example.json ${HOME}/example.json', ' ~$'),
        ).toEqual([]);
    });

    it('visits unsupported Home ranges at most linearly for mixed-token input', () => {
        const pairCount = 200;
        const text = Array.from(
            { length: pairCount },
            (_, index) =>
                `~user${index}/blocked.ts https://example.com/${index} allowed-${index}.ts`,
        ).join(' ');
        const metrics = { detectedLinkRangeVisits: 0, unsupportedHomeRangeVisits: 0 };

        expect(findTerminalLinks(text, TERMINAL_DEFAULT_WORD_SEPARATORS, metrics)).toHaveLength(
            pairCount * 2,
        );
        expect(metrics.detectedLinkRangeVisits).toBeLessThanOrEqual(pairCount * 5);
        expect(metrics.unsupportedHomeRangeVisits).toBeLessThanOrEqual(pairCount * 5);
    });

    it('keeps maximal trailing-bracket trimming bounded', () => {
        const text = `https://example.com/value${')'.repeat(16_000)}`;
        const startedAt = performance.now();

        expect(findTerminalLinks(text)).toMatchObject([
            { kind: 'url', target: 'https://example.com/value' },
        ]);
        expect(performance.now() - startedAt).toBeLessThan(500);
    });

    it('keeps maximal CJK prose boundary scanning bounded', () => {
        const text = '。'.repeat(16_000);
        const startedAt = performance.now();

        expect(findTerminalLinks(text)).toEqual([]);
        expect(performance.now() - startedAt).toBeLessThan(500);
    });
});

describe('terminalLinkHintPosition', () => {
    it('offsets the hint above and to the right of the pointer', () => {
        expect(terminalLinkHintPosition({ clientX: 100, clientY: 200 })).toEqual({
            left: 112,
            top: 172,
        });
    });
});

describe('resolveTerminalFilePath', () => {
    const context = { cwd: '/repo/packages/app', projectRoot: '/repo' };

    it('anchors bare Project paths at the root and explicit relative paths at the Terminal cwd', () => {
        expect(resolveTerminalFilePath('src/index.ts', context)).toBe('/repo/src/index.ts');
        expect(resolveTerminalFilePath('./local.ts', context)).toBe('/repo/packages/app/local.ts');
        expect(resolveTerminalFilePath('../shared.ts', context)).toBe('/repo/packages/shared.ts');
    });

    it('normalizes absolute and local file URLs without accepting remote file hosts', () => {
        expect(resolveTerminalFilePath('/repo/a/../b.ts', context)).toBe('/repo/b.ts');
        expect(resolveTerminalFilePath('file:///repo/a%20b.ts', context)).toBe('/repo/a b.ts');
        expect(resolveTerminalFilePath('file://remote/repo/a.ts', context)).toBeUndefined();
    });

    it('rejects shell-home shorthand that cannot be authorized against the Project root', () => {
        expect(resolveTerminalFilePath('~/example/path.json', context)).toBeUndefined();
    });
});

function createTerminal(text: string, cells: Array<{ chars: string; width: number }>) {
    let provider: ILinkProvider | undefined;
    let osc8Handler: ((data: string) => boolean | Promise<boolean>) | undefined;
    let markerId = 0;
    let cursorColumn = text.length;
    let cursorLine = 0;
    let terminalColumns = 120;
    let terminalRows = 1;
    let viewportLine = 0;
    const lineCells = [cells];
    const lineWrapped = [false];
    const alternateLineCells = [cellsFor('ALTERNATE')];
    const dispose = vi.fn();
    const createBufferLine = (
        currentCells: Array<{ chars: string; width: number }>,
        isWrapped: boolean,
    ) => ({
        getCell: (column: number) => {
            // `.at()` (rather than `[column]`) keeps an out-of-range index's `undefined` case in the type, since this
            // project does not enable `noUncheckedIndexedAccess`.
            const cell = currentCells.at(column);
            return cell ? { getChars: () => cell.chars, getWidth: () => cell.width } : undefined;
        },
        isWrapped,
        length: currentCells.length,
        translateToString: (
            shouldTrimRight = false,
            startColumn = 0,
            endColumn = currentCells.length,
        ) => {
            const value = currentCells
                .slice(startColumn, endColumn)
                .map(({ chars }) => chars)
                .join('');
            return shouldTrimRight ? value.trimEnd() : value;
        },
    });
    const createBuffer = (
        type: 'alternate' | 'normal',
        currentLines: Array<Array<{ chars: string; width: number }>>,
    ) => ({
        baseY: 0,
        get cursorX() {
            return cursorColumn;
        },
        get cursorY() {
            return cursorLine;
        },
        getLine: (line: number) => {
            const currentCells = currentLines.at(line);
            return currentCells
                ? createBufferLine(
                      currentCells,
                      type === 'normal' && (lineWrapped.at(line) ?? false),
                  )
                : undefined;
        },
        get length() {
            return currentLines.length;
        },
        type,
        get viewportY() {
            return viewportLine;
        },
    });
    const normalBuffer = createBuffer('normal', lineCells);
    const alternateBuffer = createBuffer('alternate', alternateLineCells);
    let activeBuffer = normalBuffer;
    const terminal = {
        buffer: {
            get active() {
                return activeBuffer;
            },
            alternate: alternateBuffer,
            normal: normalBuffer,
        },
        get cols() {
            return terminalColumns;
        },
        options: { linkHandler: null },
        parser: {
            registerOscHandler: (identifier: number, handler: typeof osc8Handler) => {
                if (identifier === 8) osc8Handler = handler;
                return { dispose: vi.fn() };
            },
        },
        registerLinkProvider: (value: ILinkProvider) => {
            provider = value;
            return { dispose };
        },
        registerMarker: (cursorYOffset = 0) => {
            const callbacks: Array<() => void> = [];
            const marker = {
                id: (markerId += 1),
                isDisposed: false,
                line: cursorLine + cursorYOffset,
                dispose: () => {
                    if (marker.isDisposed) return;
                    marker.isDisposed = true;
                    marker.line = -1;
                    for (const callback of callbacks) callback();
                },
                onDispose: (callback: () => void) => {
                    callbacks.push(callback);
                    return { dispose: vi.fn() };
                },
            };
            return marker as unknown as IMarker;
        },
        get rows() {
            return terminalRows;
        },
    } as unknown as Terminal;
    return {
        dispose,
        links(): Promise<ILink[] | undefined> {
            return new Promise((resolve) => provider?.provideLinks(1, resolve));
        },
        osc8(data: string): boolean | undefined {
            const result = osc8Handler?.(data);
            if (result instanceof Promise) throw new Error('Expected synchronous OSC test handler');
            return result;
        },
        setCursor(line: number, column: number): void {
            cursorLine = line;
            cursorColumn = column;
        },
        setActiveBuffer(type: 'alternate' | 'normal'): void {
            activeBuffer = type === 'normal' ? normalBuffer : alternateBuffer;
        },
        setLine(line: number, value: string, isWrapped = false): void {
            lineCells[line] = cellsFor(value);
            lineWrapped[line] = isWrapped;
        },
        setSize(columns: number, rows: number): void {
            terminalColumns = columns;
            terminalRows = rows;
        },
        setViewport(line: number): void {
            viewportLine = line;
        },
        terminal,
    };
}

function cellsFor(text: string): Array<{ chars: string; width: number }> {
    return [...text].map((chars) => ({ chars, width: 1 }));
}

describe('registerTerminalLinks', () => {
    const baseContext = () => {
        const openFile = vi.fn();
        const openHomeFile = vi.fn();
        const openUrl = vi.fn();
        const context: TerminalLinkContext = {
            cwd: '/repo',
            projectRoot: '/repo',
            wordSeparators: TERMINAL_DEFAULT_WORD_SEPARATORS,
            openFile,
            openHomeFile,
            openUrl,
        };
        return { context, openFile, openHomeFile, openUrl };
    };

    it('maps a link after wide CJK cells to the correct xterm range', async () => {
        const text = '中文 https://example.com';
        const terminal = createTerminal(text, [
            { chars: '中', width: 2 },
            { chars: '', width: 0 },
            { chars: '文', width: 2 },
            { chars: '', width: 0 },
            ...cellsFor(' https://example.com'),
        ]);
        const { context, openUrl } = baseContext();
        registerTerminalLinks(terminal.terminal, context);

        const links = await terminal.links();
        expect(links).toHaveLength(1);
        expect(links?.[0].range).toEqual({
            start: { x: 6, y: 1 },
            end: { x: 24, y: 1 },
        });
        links?.[0].activate({ metaKey: true } as MouseEvent, links[0].text);
        expect(openUrl).toHaveBeenCalledWith('https://example.com');
    });

    it('exposes current-viewport links with accessible actions that reuse typed activation', () => {
        const text = 'src/file.ts:12:3 src/file.ts:12:3 https://example.com';
        const terminal = createTerminal(text, cellsFor(text));
        const { context, openFile, openUrl } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        const links = registration.getViewportLinks();
        expect(
            links.map(({ accessibleName, kind, target }) => ({ accessibleName, kind, target })),
        ).toEqual([
            {
                accessibleName: 'Open file link src/file.ts:12:3',
                kind: 'file',
                target: 'src/file.ts:12:3',
            },
            {
                accessibleName: 'Open external link https://example.com',
                kind: 'url',
                target: 'https://example.com',
            },
        ]);

        links[0].activate();
        links[1].activate();
        expect(openFile).toHaveBeenCalledWith('/repo/src/file.ts', { line: 12, column: 3 });
        expect(openUrl).toHaveBeenCalledWith('https://example.com');
    });

    it('observes OSC 8 targets through public parser and marker APIs without consuming them', () => {
        const terminal = createTerminal('descriptive label', cellsFor('descriptive label'));
        const { context, openUrl } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        terminal.setCursor(0, 0);
        expect(terminal.osc8(';https://example.com/osc-target')).toBe(false);
        terminal.setCursor(0, 'descriptive label'.length);
        expect(terminal.osc8(';')).toBe(false);
        expect(registration.getViewportLinks()).toMatchObject([
            {
                accessibleName: 'Open external link https://example.com/osc-target',
                kind: 'url',
                target: 'https://example.com/osc-target',
            },
        ]);

        registration.getViewportLinks()[0].activate();
        expect(openUrl).toHaveBeenCalledWith('https://example.com/osc-target');
    });

    it('bounds same-line OSC 8 targets independently of marker disposal', () => {
        const terminal = createTerminal('descriptive labels', cellsFor('descriptive labels'));
        const { context } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        for (let index = 0; index < 1_001; index += 1) {
            terminal.setCursor(0, 0);
            terminal.osc8(`;https://example.com/osc-target-${index}`);
            terminal.setCursor(0, 'descriptive labels'.length);
            terminal.osc8(';');
        }

        const links = registration.getViewportLinks();
        expect(links).toHaveLength(1_000);
        expect(links[0]).toMatchObject({ target: 'https://example.com/osc-target-1' });
    });

    it('keeps a wrapped OSC 8 label discoverable from a visible continuation row', () => {
        const terminal = createTerminal('ABCDE', cellsFor('ABCDE'));
        terminal.setLine(1, 'FGHIJ', true);
        terminal.setSize(5, 1);
        const { context } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        terminal.setCursor(0, 0);
        terminal.osc8(';https://example.com/wrapped');
        terminal.setCursor(1, 5);
        terminal.osc8(';');
        terminal.setViewport(1);

        expect(registration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/wrapped' },
        ]);
    });

    it('drops an OSC 8 target after its visible cells are overwritten', () => {
        const terminal = createTerminal('LABEL', cellsFor('LABEL'));
        const { context } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        terminal.setCursor(0, 0);
        terminal.osc8(';https://example.com/stale');
        terminal.setCursor(0, 5);
        terminal.osc8(';');
        terminal.setLine(0, 'NEWXX');

        expect(registration.getViewportLinks()).toEqual([]);
    });

    it('preserves OSC 8 targets while an alternate buffer is active', () => {
        const terminal = createTerminal('LABEL', cellsFor('LABEL'));
        const { context } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        terminal.setCursor(0, 0);
        terminal.osc8(';https://example.com/normal-buffer');
        terminal.setCursor(0, 5);
        terminal.osc8(';');
        terminal.setActiveBuffer('alternate');
        expect(registration.getViewportLinks()).toEqual([]);

        terminal.setActiveBuffer('normal');
        expect(registration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/normal-buffer' },
        ]);
    });

    it('restores OSC 8 targets after an inactive Terminal pane remounts', () => {
        const terminalId = 'terminal-remount';
        const firstTerminal = createTerminal('LABEL', cellsFor('LABEL'));
        const { context } = baseContext();
        const firstRegistration = registerTerminalLinks(
            firstTerminal.terminal,
            context,
            terminalId,
        );

        firstTerminal.setCursor(0, 0);
        firstTerminal.osc8(';https://example.com/remounted');
        firstTerminal.setCursor(0, 5);
        firstTerminal.osc8(';');
        expect(firstRegistration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/remounted' },
        ]);
        firstRegistration.dispose();

        const remountedTerminal = createTerminal('LABEL', cellsFor('LABEL'));
        remountedTerminal.setCursor(0, 5);
        const remountedRegistration = registerTerminalLinks(
            remountedTerminal.terminal,
            context,
            terminalId,
        );
        expect(remountedRegistration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/remounted' },
        ]);

        remountedRegistration.dispose();
        clearTerminalOscLinkSnapshots(terminalId);
    });

    it('ignores a bare click without the Cmd/Ctrl activation modifier', async () => {
        const text = 'https://example.com';
        const terminal = createTerminal(text, cellsFor(text));
        const { context, openUrl } = baseContext();
        registerTerminalLinks(terminal.terminal, context);

        const links = await terminal.links();
        links?.[0].activate({} as MouseEvent, links[0].text);
        expect(openUrl).not.toHaveBeenCalled();
    });

    it('opens file links with their resolved path and location and handles OSC 8 file URLs', async () => {
        const text = 'src/file.ts:12:3';
        const terminal = createTerminal(text, cellsFor(text));
        const { context, openFile } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        const links = await terminal.links();
        links?.[0].activate({ metaKey: true } as MouseEvent, links[0].text);
        expect(openFile).toHaveBeenCalledWith('/repo/src/file.ts', {
            line: 12,
            column: 3,
        });

        terminal.terminal.options.linkHandler?.activate(
            { metaKey: true } as MouseEvent,
            'file:///repo/other.ts:8',
            { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } },
        );
        expect(openFile).toHaveBeenCalledWith('/repo/other.ts', {
            line: 8,
            column: 1,
        });

        terminal.terminal.options.linkHandler?.activate(
            { metaKey: true } as MouseEvent,
            '说明。.local-config/model-config/meta.json:4',
            { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } },
        );
        expect(openFile).toHaveBeenCalledWith('/repo/.local-config/model-config/meta.json', {
            line: 4,
            column: 1,
        });

        registration.dispose();
        expect(terminal.dispose).toHaveBeenCalledOnce();
        expect(terminal.terminal.options.linkHandler).toBeNull();
    });

    it('forwards an exact Home link to the trusted resolver without expanding it in Renderer', async () => {
        const text = '~/outside/project.json:12:4';
        const terminal = createTerminal(text, cellsFor(text));
        const { context, openFile, openHomeFile } = baseContext();
        registerTerminalLinks(terminal.terminal, context);

        const links = await terminal.links();
        links?.[0].activate({ metaKey: true } as MouseEvent, links[0].text);

        expect(openHomeFile).toHaveBeenCalledWith('~/outside/project.json', {
            line: 12,
            column: 4,
        });
        expect(openFile).not.toHaveBeenCalled();
    });
});
