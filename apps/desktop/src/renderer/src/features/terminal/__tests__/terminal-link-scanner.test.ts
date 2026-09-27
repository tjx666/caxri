import { describe, expect, it, vi } from 'vitest';

import { TERMINAL_DEFAULT_WORD_SEPARATORS } from '../terminal-file-candidate';
import { createTerminalLinkScanner } from '../terminal-link-scanner';
import type { TerminalLinkContext } from '../terminal-links';
import { MAX_TERMINAL_DETECTED_LINKS } from '../terminal-links';
import { createTerminal } from './terminal-links-test-helpers';

describe('createTerminalLinkScanner', () => {
    const baseContext = () => {
        const openFile = vi.fn();
        const openUrl = vi.fn();
        const context: TerminalLinkContext = {
            referenceContext: { githubRepositories: [], rules: [] },
            wordSeparators: TERMINAL_DEFAULT_WORD_SEPARATORS,
            openCommit: vi.fn(),
            openFile,
            openUrl,
        };
        return context;
    };

    function fillLines(terminal: ReturnType<typeof createTerminal>, count: number): void {
        for (let line = 0; line < count; line += 1) {
            terminal.setLine(line, `https://example.com/L${line}`);
        }
    }

    it('skips link kinds the pane cannot open', () => {
        const terminal = createTerminal('', []);
        terminal.setLine(0, 'src/file.ts:12 https://example.com/kept');
        const scanner = createTerminalLinkScanner(
            terminal.terminal,
            { ...baseContext(), linkKinds: new Set(['url']) },
            [],
        );

        expect(scanner.scanNextChunk().links.map((link) => link.target)).toEqual([
            'https://example.com/kept',
        ]);
    });

    it('scans the visible viewport first, then walks retained scrollback upward (most recent first)', () => {
        const terminal = createTerminal('', []);
        fillLines(terminal, 18);
        terminal.setSize(120, 3);
        terminal.setViewport(15);
        const scanner = createTerminalLinkScanner(terminal.terminal, baseContext(), []);

        const viewportChunk = scanner.scanNextChunk();
        expect(viewportChunk.status).toBe('scanning');
        expect(viewportChunk.links.map((link) => link.target)).toEqual([
            'https://example.com/L15',
            'https://example.com/L16',
            'https://example.com/L17',
        ]);

        const finalChunk = scanner.scanNextChunk();
        expect(finalChunk.status).toBe('complete');
        expect(finalChunk.links.map((link) => link.target)).toEqual([
            'https://example.com/L15',
            'https://example.com/L16',
            'https://example.com/L17',
            ...Array.from({ length: 15 }, (_unused, index) => `https://example.com/L${14 - index}`),
        ]);

        // Calling once more after completion is a no-op that returns the same accumulated result.
        expect(scanner.scanNextChunk()).toEqual(finalChunk);
    });

    it('dedupes a target repeated between the viewport and scrollback', () => {
        const terminal = createTerminal('', []);
        terminal.setLine(0, 'https://example.com/shared');
        terminal.setLine(1, 'https://example.com/shared');
        terminal.setSize(120, 1);
        terminal.setViewport(1);
        const scanner = createTerminalLinkScanner(terminal.terminal, baseContext(), []);

        scanner.scanNextChunk();
        const final = scanner.scanNextChunk();
        expect(final.status).toBe('complete');
        expect(final.links).toHaveLength(1);
        expect(final.links[0].target).toBe('https://example.com/shared');
    });

    it('reports exhausted once the shared budget is hit while walking scrollback', () => {
        const terminal = createTerminal('', []);
        fillLines(terminal, 600);
        terminal.setSize(120, 1);
        terminal.setViewport(599);
        const scanner = createTerminalLinkScanner(terminal.terminal, baseContext(), []);

        scanner.scanNextChunk();
        const afterFirstScrollbackChunk = scanner.scanNextChunk();
        expect(afterFirstScrollbackChunk.status).toBe('exhausted');
        expect(afterFirstScrollbackChunk.links).toHaveLength(MAX_TERMINAL_DETECTED_LINKS);

        // Further calls stay exhausted and stop growing the result.
        expect(scanner.scanNextChunk()).toEqual(afterFirstScrollbackChunk);
    });
});
