import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalLinkContext } from './terminal-links';
import {
    findTerminalLinks,
    registerTerminalLinks,
    resolveTerminalFilePath,
    terminalLinkHintPosition,
} from './terminal-links';

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

    it('does not turn custom protocols, flags, or ordinary dotted prose into file links', () => {
        expect(findTerminalLinks('javascript:alert(1) --flag version.')).toEqual([]);
    });

    it('keeps maximal trailing-bracket trimming bounded', () => {
        const text = `https://example.com/value${')'.repeat(16_000)}`;
        const startedAt = performance.now();

        expect(findTerminalLinks(text)).toMatchObject([
            { kind: 'url', target: 'https://example.com/value' },
        ]);
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
});

function createTerminal(text: string, cells: Array<{ chars: string; width: number }>) {
    let provider: ILinkProvider | undefined;
    const dispose = vi.fn();
    const terminal = {
        buffer: {
            active: {
                getLine: (line: number) =>
                    line === 0
                        ? {
                              getCell: (column: number) => {
                                  const cell = cells[column];
                                  return cell
                                      ? {
                                            getChars: () => cell.chars,
                                            getWidth: () => cell.width,
                                        }
                                      : undefined;
                              },
                              isWrapped: false,
                              length: cells.length,
                              translateToString: () => text,
                          }
                        : undefined,
                length: 1,
            },
        },
        cols: 120,
        options: { linkHandler: null },
        registerLinkProvider: (value: ILinkProvider) => {
            provider = value;
            return { dispose };
        },
    } as unknown as Terminal;
    return {
        dispose,
        links(): Promise<ILink[] | undefined> {
            return new Promise((resolve) => provider?.provideLinks(1, resolve));
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
        const openUrl = vi.fn();
        const context: TerminalLinkContext = {
            cwd: '/repo',
            projectRoot: '/repo',
            openFile,
            openUrl,
        };
        return { context, openFile, openUrl };
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
        const unregister = registerTerminalLinks(terminal.terminal, context);

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

        unregister();
        expect(terminal.dispose).toHaveBeenCalledOnce();
        expect(terminal.terminal.options.linkHandler).toBeNull();
    });
});
