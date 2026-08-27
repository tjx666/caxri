import { describe, expect, it, vi } from 'vitest';

import type { TerminalLinkContext } from '../terminal-links';
import {
    findTerminalLinks,
    MAX_TERMINAL_DETECTED_LINK_TARGET_BYTES,
    MAX_TERMINAL_DETECTED_LINKS,
    registerTerminalLinks,
    resolveTerminalFilePath,
    TERMINAL_DEFAULT_WORD_SEPARATORS,
    terminalLinkHintPosition,
} from '../terminal-links';
import { cellsFor, createTerminal } from './terminal-links-test-helpers';

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

    it('stops a plain-text URL before a closing wrapper and CJK prose', () => {
        const target = 'https://github.com/lobehub-biz/lobehub-cloud/pull/1503';
        const prefix = '已复用并推送 PR lobehub-cloud#1503 (';

        expect(findTerminalLinks(`${prefix}${target}），双仓 clean，PR 可合并。`)).toEqual([
            {
                endIndex: prefix.length + target.length,
                kind: 'url',
                startIndex: prefix.length,
                target,
                text: target,
            },
        ]);
    });

    it.each(['、', '，', '。', '；', '：', '！', '？'])(
        'stops a plain-text URL before CJK punctuation %s',
        (separator) => {
            const target = 'https://example.com/path?mode=review#summary';
            expect(findTerminalLinks(`${target}${separator}后续正文`)).toMatchObject([
                { kind: 'url', target, text: target },
            ]);
        },
    );

    it('trims an ASCII closing wrapper before CJK punctuation', () => {
        const target = 'https://example.com/a_(b)';

        expect(findTerminalLinks(`(${target})，后续正文`)).toMatchObject([
            { kind: 'url', target, text: target },
        ]);
    });

    it('preserves URL query, fragment, percent encoding, and balanced parentheses', () => {
        const target = 'https://example.com/a_(b)/c%20d?mode=review#summary';

        expect(findTerminalLinks(`${target}。`)).toMatchObject([
            { kind: 'url', target, text: target },
        ]);
    });

    it('extracts absolute, Project-relative, and file URL locations', () => {
        expect(
            findTerminalLinks(
                'open /repo/src/a.ts:42:7, then src/b.test.ts:9 and file:///repo/c.ts',
            ),
        ).toMatchObject([
            {
                kind: 'file',
                target: '/repo/src/a.ts',
                location: { mode: 'caret', line: 42, column: 7 },
            },
            {
                kind: 'file',
                target: 'src/b.test.ts',
                location: { mode: 'line', startLine: 9, endLine: 9 },
            },
            { kind: 'file', target: 'file:///repo/c.ts' },
        ]);
    });

    it('normalizes line-only and GitHub-style ranges without changing explicit columns', () => {
        expect(
            findTerminalLinks(
                'src/a.ts:32 src/b.ts:12:4 doctor.config.jsonc#L20-21 src/c.ts#L8-L9 src/d.ts#L7',
            ),
        ).toMatchObject([
            {
                kind: 'file',
                target: 'src/a.ts',
                location: { mode: 'line', startLine: 32, endLine: 32 },
            },
            {
                kind: 'file',
                target: 'src/b.ts',
                location: { mode: 'caret', line: 12, column: 4 },
            },
            {
                kind: 'file',
                target: 'doctor.config.jsonc',
                location: { mode: 'line', startLine: 20, endLine: 21 },
            },
            {
                kind: 'file',
                target: 'src/c.ts',
                location: { mode: 'line', startLine: 8, endLine: 9 },
            },
            {
                kind: 'file',
                target: 'src/d.ts',
                location: { mode: 'line', startLine: 7, endLine: 7 },
            },
        ]);
    });

    it('keeps URL fragments and ordinary hash filenames separate from local ranges', () => {
        const url = 'https://example.com/repo/file.ts#L20-L21';
        expect(findTerminalLinks(`${url} src/file#notes.ts`)).toMatchObject([
            { kind: 'url', target: url },
            { kind: 'file', target: 'src/file#notes.ts' },
        ]);
    });

    it('rejects zero, reversed, and incomplete line ranges', () => {
        expect(findTerminalLinks('src/a.ts#L0 src/b.ts#L21-20 src/c.ts#L2- src/d.ts:0')).toEqual(
            [],
        );
    });

    it('trims sentence punctuation after a complete line range', () => {
        expect(findTerminalLinks('(doctor.config.jsonc#L20-L21)，done')).toMatchObject([
            {
                kind: 'file',
                target: 'doctor.config.jsonc',
                text: 'doctor.config.jsonc#L20-L21',
                location: { mode: 'line', startLine: 20, endLine: 21 },
            },
        ]);
    });

    it('preserves framework path segments before a location suffix and excludes sentence punctuation', () => {
        const target = 'src/app/(backend)/webapi/chat/[provider]/route.ts';
        const linkText = `${target}:43`;
        const prefix = 'See ';

        expect(findTerminalLinks(`${prefix}${linkText}。`)).toEqual([
            {
                endIndex: prefix.length + linkText.length,
                kind: 'file',
                location: { mode: 'line', startLine: 43, endLine: 43 },
                startIndex: prefix.length,
                target,
                text: linkText,
            },
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
                endIndex: text.length,
                kind: 'file',
                location: { mode: 'line', startLine: 4, endLine: 4 },
                startIndex: 3,
                target: '.local-config/model-config/meta.json',
                text: '.local-config/model-config/meta.json:4',
            },
        ]);
    });

    it('preserves CJK punctuation inside valid relative paths', () => {
        expect(findTerminalLinks('./目录。版本/file.ts:8')).toMatchObject([
            {
                kind: 'file',
                target: './目录。版本/file.ts',
                location: { mode: 'line', startLine: 8, endLine: 8 },
            },
        ]);
        expect(findTerminalLinks('目录。版本/file.ts:8')).toMatchObject([
            {
                kind: 'file',
                target: '目录。版本/file.ts',
                location: { mode: 'line', startLine: 8, endLine: 8 },
            },
        ]);
        expect(findTerminalLinks('目录。version/file.ts:8')).toMatchObject([
            {
                kind: 'file',
                target: '目录。version/file.ts',
                location: { mode: 'line', startLine: 8, endLine: 8 },
            },
        ]);
        expect(findTerminalLinks('docs/中文说明.md')).toMatchObject([
            { kind: 'file', target: 'docs/中文说明.md' },
        ]);
    });

    it('honors custom word separators from the terminal.wordSeparators setting', () => {
        // Word separators still control fallback tokenization, while the higher-priority local-file
        // parser recognizes an explicit location independently, matching VS Code's detector order.
        expect(findTerminalLinks('串联(src/api/x.ts)', ' ')).toMatchObject([
            { kind: 'file', target: '串联(src/api/x.ts)' },
        ]);
        expect(
            findTerminalLinks('说明。.local-config/model-config/meta.json:4', ' '),
        ).toMatchObject([
            {
                kind: 'file',
                target: '说明。.local-config/model-config/meta.json',
                location: { mode: 'line', startLine: 4, endLine: 4 },
            },
        ]);
        const withColonSeparator = findTerminalLinks('src/a.ts:12', ' :');
        expect(withColonSeparator).toMatchObject([
            {
                kind: 'file',
                target: 'src/a.ts',
                location: { mode: 'line', startLine: 12, endLine: 12 },
            },
        ]);
    });

    it('does not turn custom protocols, flags, or ordinary dotted prose into file links', () => {
        expect(findTerminalLinks('javascript:alert(1) --flag version.')).toEqual([]);
    });

    it('offers exact current-user Home paths without accepting other shell expansion forms', () => {
        expect(findTerminalLinks('config: ~/example/path.json:7')).toMatchObject([
            {
                kind: 'file',
                target: '~/example/path.json',
                location: { mode: 'line', startLine: 7, endLine: 7 },
            },
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
        expect(openFile).toHaveBeenCalledWith('/repo/src/file.ts', {
            mode: 'caret',
            line: 12,
            column: 3,
        });

        terminal.terminal.options.linkHandler?.activate(
            { metaKey: true } as MouseEvent,
            'src/range.ts#L20-L21',
            { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } },
        );
        expect(openFile).toHaveBeenCalledWith('/repo/src/range.ts', {
            mode: 'line',
            startLine: 20,
            endLine: 21,
        });
        expect(openUrl).toHaveBeenCalledWith('https://example.com');
    });

    it('bounds the picker candidate count across an adversarial visible grid', () => {
        const terminal = createTerminal('', []);
        terminal.setSize(80, 250);
        for (let line = 0; line < 250; line += 1) {
            terminal.setLine(line, `https://example.com/${line}`);
        }
        const { context } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        expect(registration.getViewportLinks()).toHaveLength(MAX_TERMINAL_DETECTED_LINKS);
    });

    it('bounds aggregate UTF-8 target bytes retained for one picker invocation', () => {
        const terminal = createTerminal('', []);
        terminal.setSize(6_000, 5);
        for (let line = 0; line < 5; line += 1) {
            terminal.setLine(line, `https://example.com/${'界'.repeat(5_000)}${line}`);
        }
        const { context } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);
        const targetBytes = registration
            .getViewportLinks()
            .reduce((total, link) => total + new TextEncoder().encode(link.target).byteLength, 0);

        expect(targetBytes).toBeLessThanOrEqual(MAX_TERMINAL_DETECTED_LINK_TARGET_BYTES);
    });

    it('observes OSC 8 targets through public parser and marker APIs without consuming them', () => {
        const terminal = createTerminal('descriptive label', cellsFor('descriptive label'));
        const { context, openUrl } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);
        const target = 'https://example.com/search?q=你好，世界';

        terminal.setCursor(0, 0);
        expect(terminal.osc8(`;${target}`)).toBe(false);
        terminal.setCursor(0, 'descriptive label'.length);
        expect(terminal.osc8(';')).toBe(false);
        expect(registration.getViewportLinks()).toMatchObject([
            {
                accessibleName: `Open external link ${target}`,
                kind: 'url',
                target,
            },
        ]);

        registration.getViewportLinks()[0].activate();
        expect(openUrl).toHaveBeenCalledWith(target);
    });

    it('bounds OSC 8 targets independently of marker disposal', () => {
        const terminal = createTerminal('x', cellsFor('x'));
        const { context } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);
        terminal.setSize(1, 1);

        for (let index = 0; index < 1_001; index += 1) {
            terminal.setLine(index, 'x');
            terminal.setCursor(index, 0);
            terminal.osc8(`;https://example.com/osc-target-${index}`);
            terminal.setCursor(index, 1);
            terminal.osc8(';');
        }

        terminal.setViewport(1);
        expect(registration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/osc-target-1' },
        ]);
        terminal.setViewport(1_000);
        expect(registration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/osc-target-1000' },
        ]);
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

    it('keeps an OSC 8 label when growing columns removes its wrapped endpoint row', () => {
        const terminal = createTerminal('x'.repeat(20), cellsFor('x'.repeat(20)));
        terminal.setLine(1, 'x', true);
        terminal.setSize(20, 2);
        const { context } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        terminal.setCursor(0, 0);
        terminal.osc8(';https://example.com/grow-reflow');
        terminal.setCursor(1, 1);
        terminal.osc8(';');
        expect(registration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/grow-reflow' },
        ]);

        terminal.reflowNormal(['x'.repeat(21)], 30);
        terminal.disposeMarkersAtLine(1);

        expect(registration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/grow-reflow' },
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

    it('restores only the Runtime-authoritative OSC 8 target after a pane remount', () => {
        const firstTerminal = createTerminal('LABEL', cellsFor('LABEL'));
        const { context } = baseContext();
        const firstRegistration = registerTerminalLinks(firstTerminal.terminal, context);

        firstTerminal.setCursor(0, 0);
        firstTerminal.osc8(';https://example.com/stale-before-remount');
        firstTerminal.setCursor(0, 5);
        firstTerminal.osc8(';');
        expect(firstRegistration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/stale-before-remount' },
        ]);
        firstRegistration.dispose();

        const remountedTerminal = createTerminal('LABEL', cellsFor('LABEL'));
        remountedTerminal.setCursor(0, 5);
        const remountedRegistration = registerTerminalLinks(remountedTerminal.terminal, context);
        expect(remountedRegistration.getViewportLinks()).toEqual([]);

        remountedRegistration.restoreOscLinks([
            {
                buffer: 'normal',
                endCellOffset: 5,
                endLogicalLineIndex: 0,
                endLogicalLineOffset: -1,
                fingerprint: '5:1625091293',
                startCellOffset: 0,
                startLogicalLineIndex: 0,
                startLogicalLineOffset: -1,
                target: 'https://example.com/authoritative-after-remount',
            },
        ]);
        expect(remountedRegistration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/authoritative-after-remount' },
        ]);

        remountedRegistration.dispose();
    });

    it('defers normal-buffer OSC 8 restoration until an alternate-screen remount returns', () => {
        const terminal = createTerminal('LABEL', cellsFor('LABEL'));
        const { context } = baseContext();
        terminal.setActiveBuffer('alternate');
        terminal.setCursor(0, 'ALTERNATE'.length);
        const registration = registerTerminalLinks(terminal.terminal, context);

        registration.restoreOscLinks([
            {
                buffer: 'normal',
                endCellOffset: 5,
                endLogicalLineIndex: 0,
                endLogicalLineOffset: -1,
                fingerprint: '5:1625091293',
                startCellOffset: 0,
                startLogicalLineIndex: 0,
                startLogicalLineOffset: -1,
                target: 'https://example.com/normal-after-alternate',
            },
        ]);
        expect(registration.getViewportLinks()).toEqual([]);

        terminal.setCursor(0, 5);
        terminal.setActiveBuffer('normal');
        expect(registration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/normal-after-alternate' },
        ]);

        registration.dispose();
    });

    it('restores an OSC 8 target from an active alternate-buffer snapshot', () => {
        const terminal = createTerminal('NORMAL', cellsFor('NORMAL'));
        terminal.setAlternateLine(0, 'LABEL');
        terminal.setActiveBuffer('alternate');
        terminal.setCursor(0, 5);
        const { context } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        registration.restoreOscLinks([
            {
                buffer: 'alternate',
                endCellOffset: 5,
                endLogicalLineIndex: 0,
                endLogicalLineOffset: -1,
                fingerprint: '5:1625091293',
                startCellOffset: 0,
                startLogicalLineIndex: 0,
                startLogicalLineOffset: -1,
                target: 'https://example.com/alternate-after-remount',
            },
        ]);

        expect(registration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/alternate-after-remount' },
        ]);
        registration.dispose();
    });

    it('restores a deferred normal-buffer OSC 8 target after inactive-buffer reflow', () => {
        const terminal = createTerminal('PREFIXLABEL', cellsFor('PREFIXLABEL'));
        const { context } = baseContext();
        terminal.setActiveBuffer('alternate');
        terminal.setCursor(0, 'ALTERNATE'.length);
        const registration = registerTerminalLinks(terminal.terminal, context);

        registration.restoreOscLinks([
            {
                buffer: 'normal',
                endCellOffset: 11,
                endLogicalLineIndex: 0,
                endLogicalLineOffset: -1,
                fingerprint: '5:1625091293',
                startCellOffset: 6,
                startLogicalLineIndex: 0,
                startLogicalLineOffset: -1,
                target: 'https://example.com/normal-after-reflow',
            },
        ]);
        terminal.reflowNormal(['PREFIX', 'LABEL'], 6);

        terminal.setCursor(1, 5);
        terminal.setActiveBuffer('normal');
        terminal.setViewport(1);
        expect(registration.getViewportLinks()).toMatchObject([
            { target: 'https://example.com/normal-after-reflow' },
        ]);

        registration.dispose();
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
            mode: 'caret',
            line: 12,
            column: 3,
        });

        terminal.terminal.options.linkHandler?.activate(
            { metaKey: true } as MouseEvent,
            'file:///repo/other.ts:8',
            { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } },
        );
        expect(openFile).toHaveBeenCalledWith('/repo/other.ts', {
            mode: 'line',
            startLine: 8,
            endLine: 8,
        });

        terminal.terminal.options.linkHandler?.activate(
            { metaKey: true } as MouseEvent,
            '说明。.local-config/model-config/meta.json:4',
            { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } },
        );
        expect(openFile).toHaveBeenCalledWith('/repo/.local-config/model-config/meta.json', {
            mode: 'line',
            startLine: 4,
            endLine: 4,
        });

        registration.dispose();
        expect(terminal.dispose).toHaveBeenCalledOnce();
        expect(terminal.terminal.options.linkHandler).toBeNull();
    });

    it('forwards an exact Home link to the trusted resolver without expanding it in Renderer', async () => {
        const text = '~/outside/project.json#L12-L14';
        const terminal = createTerminal(text, cellsFor(text));
        const { context, openFile, openHomeFile } = baseContext();
        registerTerminalLinks(terminal.terminal, context);

        const links = await terminal.links();
        links?.[0].activate({ metaKey: true } as MouseEvent, links[0].text);

        expect(openHomeFile).toHaveBeenCalledWith('~/outside/project.json', {
            mode: 'line',
            startLine: 12,
            endLine: 14,
        });
        expect(openFile).not.toHaveBeenCalled();
    });
});
