import { describe, expect, it } from 'vitest';

import {
    MAX_TERMINAL_TITLE_LENGTH,
    normalizeTerminalTitle,
    terminalDisplayTitle,
    terminalTabLabel,
} from '../terminal-title';

/**
 * Constructed, never written literally: a raw control character in a source file makes Git classify the whole `.ts`
 * file as binary, which silently turns every assertion here into an unreviewable patch.
 */
const NUL = String.fromCodePoint(0x00);
const BELL = String.fromCodePoint(0x07);
const ESCAPE = String.fromCodePoint(0x1b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x20_2e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x20_0b);
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x20_0d);

describe('terminalTabLabel', () => {
    it('drops the prompt host prefix that is identical on every local tab', () => {
        expect(terminalTabLabel('tj@macbook:~/code')).toBe('~/code');
    });

    it('compresses a deep path down to its identifying tail', () => {
        expect(terminalTabLabel('tj@macbook:~/code/caxri-worktrees/feat-work-tab-layout')).toBe(
            '~/…/feat-work-tab-layout',
        );
        expect(terminalTabLabel('/Users/tj/code/caxri')).toBe('/…/caxri');
        expect(terminalTabLabel('../code/caxri-worktrees/feat-x')).toBe('../…/feat-x');
    });

    it('compresses a path whose directory names contain spaces', () => {
        expect(terminalTabLabel('tj@macbook:~/Code/My Project/src/app')).toBe('~/…/app');
    });

    it('ignores a trailing slash rather than compressing to an empty tail', () => {
        expect(terminalTabLabel('~/code/caxri-worktrees/feat-x/')).toBe('~/…/feat-x');
    });

    it('leaves a path short enough that the ellipsis would save nothing', () => {
        expect(terminalTabLabel('~/code')).toBe('~/code');
        expect(terminalTabLabel('~/code/caxri')).toBe('~/code/caxri');
    });

    it('leaves anything that is not a rooted path intact', () => {
        expect(terminalTabLabel('Fix the tab strip / verify layout')).toBe(
            'Fix the tab strip / verify layout',
        );
        expect(terminalTabLabel('Fix/verify/now/please')).toBe('Fix/verify/now/please');
        expect(terminalTabLabel('https://example.com/a/b')).toBe('https://example.com/a/b');
    });

    it('keeps a title that is only a host prefix rather than rendering an empty tab', () => {
        expect(terminalTabLabel('tj@macbook:')).toBe('tj@macbook:');
    });

    it('passes through a plain title', () => {
        expect(terminalTabLabel('Shell')).toBe('Shell');
    });
});

describe('normalizeTerminalTitle', () => {
    it('flattens control characters and collapsed whitespace into a single line', () => {
        expect(normalizeTerminalTitle(`  zsh${NUL}\r\n  \tcaxri ${BELL} `)).toBe('zsh caxri');
    });

    it('rejects a payload with nothing printable so the previous title survives', () => {
        expect(normalizeTerminalTitle(`${NUL}${ESCAPE}   `)).toBeUndefined();
        expect(normalizeTerminalTitle('')).toBeUndefined();
    });

    it('drops invisible formatting a process could use to disguise one Terminal as another', () => {
        expect(normalizeTerminalTitle(`${RIGHT_TO_LEFT_OVERRIDE}gnp.eldnab`)).toBe('gnp.eldnab');
        expect(normalizeTerminalTitle(`ca${ZERO_WIDTH_SPACE}xri`)).toBe('caxri');
    });

    it('keeps the joiners that legitimate emoji and script sequences depend on', () => {
        expect(normalizeTerminalTitle(`a${ZERO_WIDTH_JOINER}b`)).toBe(`a${ZERO_WIDTH_JOINER}b`);
    });

    it('bounds an oversized payload without materialising it', () => {
        const normalized = normalizeTerminalTitle('x'.repeat(10_000));
        expect(normalized).toHaveLength(MAX_TERMINAL_TITLE_LENGTH);
    });

    it('never ends a bounded title on a dangling separator', () => {
        const normalized = normalizeTerminalTitle(`${'x'.repeat(MAX_TERMINAL_TITLE_LENGTH)} tail`);
        expect(normalized).toBe('x'.repeat(MAX_TERMINAL_TITLE_LENGTH));
    });
});

describe('terminalDisplayTitle', () => {
    it('lets a Shell be named by whatever its process last announced', () => {
        expect(
            terminalDisplayTitle({ provider: undefined, ptyTitle: '~/code/caxri', title: 'Shell' }),
        ).toBe('~/code/caxri');
    });

    it('falls back to the stable title while a Shell has announced nothing', () => {
        expect(
            terminalDisplayTitle({ provider: undefined, ptyTitle: undefined, title: 'Shell' }),
        ).toBe('Shell');
    });

    /**
     * An Agent CLI paints its own status string into the window title, which must not displace the conversation the tab
     * identifies.
     */
    it('keeps an Agent Terminal named by its conversation, not by the CLI window title', () => {
        expect(
            terminalDisplayTitle({
                provider: 'claude',
                ptyTitle: '✳ claude',
                title: 'Ship the release notes',
            }),
        ).toBe('Ship the release notes');
    });
});
