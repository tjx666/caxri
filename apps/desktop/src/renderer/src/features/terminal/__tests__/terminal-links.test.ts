import { describe, expect, it, vi } from 'vitest';

import { TERMINAL_DEFAULT_WORD_SEPARATORS } from '../terminal-file-candidate';
import { terminalLinkHintText } from '../terminal-link-copy';
import type { TerminalLinkContext } from '../terminal-links';
import {
    findTerminalLinks,
    MAX_TERMINAL_DETECTED_LINK_TARGET_BYTES,
    MAX_TERMINAL_DETECTED_LINKS,
    registerTerminalLinks,
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

    it('stops a wrapped URL before an adjacent CJK label', () => {
        const target = 'https://github.com/example/example/pull/18958';
        const prefix = 'PR example#18958 (';

        expect(findTerminalLinks(`${prefix}${target})(目标 canary)。`)).toEqual([
            {
                endIndex: prefix.length + target.length,
                kind: 'url',
                startIndex: prefix.length,
                target,
                text: target,
            },
        ]);
    });

    it.each(['(', '[', '{', '（'])(
        'stops a URL before an adjacent CJK note opened by %s',
        (opener) => {
            const target = 'https://example.com/acceptance/round-id';

            expect(findTerminalLinks(`${target}${opener}覆盖 all checks)`)).toEqual([
                {
                    endIndex: target.length,
                    kind: 'url',
                    startIndex: 0,
                    target,
                    text: target,
                },
            ]);
        },
    );

    it('describes the destination for plain URL and file links', () => {
        const links = findTerminalLinks('https://example.com src/example.ts:12');

        expect(links.map(terminalLinkHintText)).toEqual([
            '⌘ click to open in browser',
            '⌘ click to open in editor',
        ]);
    });

    it('stops a plain-text URL before a closing wrapper and CJK prose', () => {
        const target = 'https://github.com/example-biz/example-cloud/pull/1234';
        const prefix = '已复用并推送 PR example-cloud#1234 (';

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
        const target = 'https://example.com/a_(覆盖范围)/c%20d?mode=review#summary';

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
});

describe('registerTerminalLinks', () => {
    const baseContext = () => {
        const openFile = vi.fn();
        const openCommit = vi.fn();
        const openUrl = vi.fn();
        const context: TerminalLinkContext = {
            referenceContext: { githubRepositories: [], rules: [] },
            wordSeparators: TERMINAL_DEFAULT_WORD_SEPARATORS,
            openCommit,
            openFile,
            openUrl,
        };
        return { context, openCommit, openFile, openUrl };
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

    it('exposes a bare path separated from CJK prose by punctuation', async () => {
        const text = '说明。workspace/apps/server/src/file.ts:15';
        const terminal = createTerminal(text, cellsFor(text));
        const { context, openFile } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        expect(await terminal.links()).toMatchObject([
            { text: 'workspace/apps/server/src/file.ts:15', range: { start: { x: 4, y: 1 } } },
        ]);
        expect(registration.getViewportLinks()).toMatchObject([
            { kind: 'file', target: 'workspace/apps/server/src/file.ts:15' },
        ]);
        terminal.terminal.options.linkHandler?.activate({ metaKey: true } as MouseEvent, text, {
            start: { x: 1, y: 1 },
            end: { x: 1, y: 1 },
        });
        expect(openFile).toHaveBeenCalledWith('workspace/apps/server/src/file.ts', {
            mode: 'line',
            startLine: 15,
            endLine: 15,
        });
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
        expect(openFile).toHaveBeenCalledWith('src/file.ts', {
            mode: 'caret',
            line: 12,
            column: 3,
        });

        terminal.terminal.options.linkHandler?.activate(
            { metaKey: true } as MouseEvent,
            'src/range.ts#L20-L21',
            { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } },
        );
        expect(openFile).toHaveBeenCalledWith('src/range.ts', {
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
        const target = 'https://example.com/search(q=你好，世界';

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

    it('ignores bare and Ctrl clicks without the macOS Cmd activation modifier', async () => {
        const text = 'https://example.com';
        const terminal = createTerminal(text, cellsFor(text));
        const { context, openUrl } = baseContext();
        registerTerminalLinks(terminal.terminal, context);

        const links = await terminal.links();
        links?.[0].activate({} as MouseEvent, links[0].text);
        links?.[0].activate({ ctrlKey: true } as MouseEvent, links[0].text);
        expect(openUrl).not.toHaveBeenCalled();
    });

    it('offers only the link kinds its pane can open, through every detection path', async () => {
        const text = 'src/file.ts:12 f36a02ac https://example.com/plain';
        const terminal = createTerminal(text, cellsFor(text));
        const { context, openCommit, openFile, openUrl } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, {
            ...context,
            linkKinds: new Set(['url']),
        });

        const links = await terminal.links();
        expect(links?.map((link) => link.text)).toEqual(['https://example.com/plain']);
        expect(registration.getViewportLinks()).toMatchObject([
            { kind: 'url', target: 'https://example.com/plain' },
        ]);
        const handler = terminal.terminal.options.linkHandler;
        expect(handler?.allowNonHttpProtocols).toBe(false);
        const range = { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } };
        handler?.activate({ metaKey: true } as MouseEvent, 'src/file.ts:12', range);
        handler?.activate({ metaKey: true } as MouseEvent, 'https://example.com/osc', range);
        expect(openFile).not.toHaveBeenCalled();
        expect(openCommit).not.toHaveBeenCalled();
        expect(openUrl).toHaveBeenCalledWith('https://example.com/osc');

        terminal.setCursor(0, 0);
        terminal.osc8(';src/osc.ts');
        terminal.setCursor(0, 4);
        terminal.osc8(';');
        expect(registration.getAllOscLinks()).toEqual([]);
    });

    it('routes a modified click on a commit candidate through the Git resolver callback', async () => {
        const text = 'f36a02ac';
        const terminal = createTerminal(text, cellsFor(text));
        const { context, openCommit } = baseContext();
        registerTerminalLinks(terminal.terminal, context);

        const links = await terminal.links();
        links?.[0].activate({ metaKey: true } as MouseEvent, links[0].text);

        expect(openCommit).toHaveBeenCalledWith(text);
    });

    it('forwards raw file targets and locations through the shared trusted resolver', async () => {
        const text = 'src/file.ts:12:3';
        const terminal = createTerminal(text, cellsFor(text));
        const { context, openFile } = baseContext();
        const registration = registerTerminalLinks(terminal.terminal, context);

        const links = await terminal.links();
        links?.[0].activate({ metaKey: true } as MouseEvent, links[0].text);
        expect(openFile).toHaveBeenCalledWith('src/file.ts', {
            mode: 'caret',
            line: 12,
            column: 3,
        });

        terminal.terminal.options.linkHandler?.activate(
            { metaKey: true } as MouseEvent,
            'file:///repo/other.ts:8',
            { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } },
        );
        expect(openFile).toHaveBeenCalledWith('file:///repo/other.ts', {
            mode: 'line',
            startLine: 8,
            endLine: 8,
        });

        terminal.terminal.options.linkHandler?.activate(
            { metaKey: true } as MouseEvent,
            '说明。.local-config/model-config/meta.json:4',
            { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } },
        );
        expect(openFile).toHaveBeenCalledWith('.local-config/model-config/meta.json', {
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
        const { context, openFile } = baseContext();
        registerTerminalLinks(terminal.terminal, context);

        const links = await terminal.links();
        links?.[0].activate({ metaKey: true } as MouseEvent, links[0].text);

        expect(openFile).toHaveBeenCalledWith('~/outside/project.json', {
            mode: 'line',
            startLine: 12,
            endLine: 14,
        });
    });
});
