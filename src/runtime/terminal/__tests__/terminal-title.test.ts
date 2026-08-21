import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '../../../shared/ipc/events';
import { TerminalScreenState } from '../screen';
import {
    createTerminalTitleListener,
    MAX_TERMINAL_TITLE_LENGTH,
    normalizeTerminalTitle,
    TERMINAL_TITLE_THROTTLE_MS,
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

function createStore() {
    const titles = new Map<string, string>();
    return {
        titles,
        setTerminalTitle(id: string, title: string): boolean {
            if (titles.get(id) === title) return false;
            titles.set(id, title);
            return true;
        },
    };
}

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

describe('createTerminalTitleListener', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('persists the first title immediately and broadcasts the Terminal record', () => {
        const store = createStore();
        const events: RuntimeEvent[] = [];
        const listen = createTerminalTitleListener('t1', store, (event) => events.push(event));
        listen('zsh caxri');
        expect(store.titles.get('t1')).toBe('zsh caxri');
        expect(events).toEqual([
            {
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: ['t1'] },
            },
        ]);
    });

    it('collapses a burst to its leading and final title', () => {
        const store = createStore();
        const events: RuntimeEvent[] = [];
        const listen = createTerminalTitleListener('t1', store, (event) => events.push(event));
        listen('first');
        listen('middle');
        listen('last');
        expect(store.titles.get('t1')).toBe('first');
        vi.advanceTimersByTime(TERMINAL_TITLE_THROTTLE_MS);
        expect(store.titles.get('t1')).toBe('last');
        expect(events).toHaveLength(2);
    });

    it('does not rewrite or rebroadcast an unchanged title', () => {
        const store = createStore();
        const events: RuntimeEvent[] = [];
        const listen = createTerminalTitleListener('t1', store, (event) => events.push(event));
        listen('zsh');
        vi.advanceTimersByTime(TERMINAL_TITLE_THROTTLE_MS);
        listen('zsh');
        vi.advanceTimersByTime(TERMINAL_TITLE_THROTTLE_MS);
        expect(events).toHaveLength(1);
    });

    it('drops a pending title once cancelled so a retired PTY cannot outlive its Terminal', () => {
        const store = createStore();
        const listen = createTerminalTitleListener('t1', store, () => {});
        listen('old-leading');
        listen('old-trailing');
        listen.cancel();
        // The replacement PTY reuses the durable Terminal ID and writes its own title.
        store.setTerminalTitle('t1', 'restarted');
        vi.advanceTimersByTime(TERMINAL_TITLE_THROTTLE_MS * 4);
        expect(store.titles.get('t1')).toBe('restarted');
    });

    it('ignores a payload that normalizes to nothing', () => {
        const store = createStore();
        const events: RuntimeEvent[] = [];
        const listen = createTerminalTitleListener('t1', store, (event) => events.push(event));
        listen(`${NUL}${ESCAPE}`);
        vi.advanceTimersByTime(TERMINAL_TITLE_THROTTLE_MS);
        expect(store.titles.size).toBe(0);
        expect(events).toHaveLength(0);
    });
});

describe('TerminalScreenState title observation', () => {
    it('reports the OSC 0 window title xterm parses out of the PTY stream', async () => {
        const observed: string[] = [];
        const screen = new TerminalScreenState('', 80, 24, {
            onTitleChange: Object.assign((title: string) => observed.push(title), {
                cancel: () => {},
            }),
        });
        screen.write(`${ESCAPE}]0;zsh caxri${BELL}`);
        await screen.snapshot();
        expect(observed).toEqual(['zsh caxri']);
        screen.dispose();
    });

    it('cancels its observer on dispose so the retired parser stops writing', () => {
        const cancel = vi.fn();
        const screen = new TerminalScreenState('', 80, 24, {
            onTitleChange: Object.assign(() => {}, { cancel }),
        });
        screen.dispose();
        screen.dispose();
        expect(cancel).toHaveBeenCalledTimes(1);
    });
});
