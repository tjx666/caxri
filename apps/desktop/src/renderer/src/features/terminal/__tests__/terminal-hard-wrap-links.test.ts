import { describe, expect, it, vi } from 'vitest';

import type { TerminalLinkContext } from '../terminal-links';
import {
    joinCodexHardWrappedFileLink,
    registerTerminalLinks,
    TERMINAL_DEFAULT_WORD_SEPARATORS,
} from '../terminal-links';
import { cellsFor, createTerminal } from './terminal-links-test-helpers';

const FIRST_FRAGMENT = '/Users/tj/code/lobehub-cloud-2-';
const CONTINUATION =
    '  lobe-13558/lobehub/packages/builtin-tool-local-system/src/systemRole.desktop.ts:56:7';
const COMPLETE_TARGET =
    '/Users/tj/code/lobehub-cloud-2-lobe-13558/lobehub/packages/builtin-tool-local-system/src/systemRole.desktop.ts';

function context() {
    const openFile = vi.fn();
    const value: TerminalLinkContext = {
        wordSeparators: TERMINAL_DEFAULT_WORD_SEPARATORS,
        openFile,
        openUrl: vi.fn(),
    };
    return { openFile, value };
}

describe('joinCodexHardWrappedFileLink', () => {
    it('reconstructs one location-suffixed path from a Codex-indented continuation', () => {
        expect(joinCodexHardWrappedFileLink(FIRST_FRAGMENT, CONTINUATION)).toEqual({
            continuationOffset: 2,
            text: `${COMPLETE_TARGET}:56:7`,
        });
    });

    it('rejects adjacent rooted paths, completed paths, and ordinary prose', () => {
        expect(joinCodexHardWrappedFileLink('/repo/one-', '  /repo/two.ts:9')).toBeUndefined();
        expect(joinCodexHardWrappedFileLink('/repo/one.ts', '  src/two.ts:9')).toBeUndefined();
        expect(joinCodexHardWrappedFileLink('/repo/one-', '  followed by prose')).toBeUndefined();
    });
});

describe('Codex hard-wrapped Terminal links', () => {
    it('provides one complete cross-row link from either physical row', async () => {
        const terminal = createTerminal(FIRST_FRAGMENT, cellsFor(FIRST_FRAGMENT));
        terminal.setLine(1, CONTINUATION);
        terminal.setSize(120, 2);
        const { openFile, value } = context();
        registerTerminalLinks(terminal.terminal, value);

        const firstRowLinks = await terminal.links(1);
        const secondRowLinks = await terminal.links(2);

        for (const links of [firstRowLinks, secondRowLinks]) {
            expect(links).toHaveLength(1);
            expect(links?.[0]).toMatchObject({
                range: { start: { x: 1, y: 1 }, end: { x: CONTINUATION.length, y: 2 } },
                text: `${COMPLETE_TARGET}:56:7`,
            });
        }
        firstRowLinks?.[0].activate({ metaKey: true } as MouseEvent, firstRowLinks[0].text);
        secondRowLinks?.[0].activate({ metaKey: true } as MouseEvent, secondRowLinks[0].text);
        expect(openFile).toHaveBeenCalledTimes(2);
        expect(openFile).toHaveBeenNthCalledWith(1, COMPLETE_TARGET, {
            mode: 'caret',
            line: 56,
            column: 7,
        });
        expect(openFile).toHaveBeenNthCalledWith(2, COMPLETE_TARGET, {
            mode: 'caret',
            line: 56,
            column: 7,
        });
    });

    it('lists the complete target once when only the continuation row is visible', () => {
        const terminal = createTerminal(FIRST_FRAGMENT, cellsFor(FIRST_FRAGMENT));
        terminal.setLine(1, CONTINUATION);
        terminal.setSize(120, 1);
        terminal.setViewport(1);
        const { value } = context();
        const registration = registerTerminalLinks(terminal.terminal, value);

        expect(registration.getViewportLinks()).toMatchObject([
            {
                accessibleName: `Open file link ${COMPLETE_TARGET}:56:7`,
                bufferLine: 0,
                kind: 'file',
                target: `${COMPLETE_TARGET}:56:7`,
            },
        ]);
    });

    it('reconstructs a path split across three explicit physical rows', async () => {
        const first = '/repo/lobehub-cloud-2-';
        const middle = '  lobe-13558/packages/builtin-';
        const last = '  tool-local-system/src/file.ts:56';
        const terminal = createTerminal(first, cellsFor(first));
        terminal.setLine(1, middle);
        terminal.setLine(2, last);
        terminal.setSize(120, 3);
        const { openFile, value } = context();
        registerTerminalLinks(terminal.terminal, value);

        const complete =
            '/repo/lobehub-cloud-2-lobe-13558/packages/builtin-tool-local-system/src/file.ts:56';
        const linksByRow = await Promise.all([
            terminal.links(1),
            terminal.links(2),
            terminal.links(3),
        ]);
        for (const links of linksByRow)
            expect(links).toMatchObject([
                {
                    range: { start: { x: 1, y: 1 }, end: { x: last.length, y: 3 } },
                    text: complete,
                },
            ]);

        linksByRow[2]?.[0].activate({ metaKey: true } as MouseEvent, complete);
        expect(openFile).toHaveBeenCalledWith(
            '/repo/lobehub-cloud-2-lobe-13558/packages/builtin-tool-local-system/src/file.ts',
            { mode: 'line', startLine: 56, endLine: 56 },
        );
    });

    it('recomputes ranges from current buffer rows after the output changes', async () => {
        const terminal = createTerminal(FIRST_FRAGMENT, cellsFor(FIRST_FRAGMENT));
        terminal.setLine(1, CONTINUATION);
        terminal.setSize(120, 2);
        const { value } = context();
        registerTerminalLinks(terminal.terminal, value);
        expect(await terminal.links(2)).toMatchObject([{ text: `${COMPLETE_TARGET}:56:7` }]);

        terminal.setLine(0, '/repo/one.ts');
        terminal.setLine(1, '  /repo/two.ts:9');

        expect(await terminal.links(2)).toMatchObject([
            {
                range: { start: { x: 3, y: 2 }, end: { x: 16, y: 2 } },
                text: '/repo/two.ts:9',
            },
        ]);
    });

    it('keeps adjacent independent paths as separate links', () => {
        const first = '/repo/one.ts';
        const second = '  /repo/two.ts:9';
        const terminal = createTerminal(first, cellsFor(first));
        terminal.setLine(1, second);
        terminal.setSize(120, 2);
        const { value } = context();
        const registration = registerTerminalLinks(terminal.terminal, value);

        expect(registration.getViewportLinks().map(({ target }) => target)).toEqual([
            '/repo/one.ts',
            '/repo/two.ts:9',
        ]);
    });
});
