import type { ServerEvent } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalScreenState } from '../screen';
import { createTerminalTitleListener, TERMINAL_TITLE_THROTTLE_MS } from '../terminal-title';

/**
 * Constructed, never written literally: a raw control character in a source file makes Git classify the whole `.ts`
 * file as binary, which silently turns every assertion here into an unreviewable patch.
 */
const NUL = String.fromCodePoint(0x00);
const BELL = String.fromCodePoint(0x07);
const ESCAPE = String.fromCodePoint(0x1b);

function createStore() {
    const providers = new Map<string, 'claude' | 'codex'>();
    const titles = new Map<string, string>();
    return {
        providers,
        titles,
        getTerminal(id: string) {
            return { provider: providers.get(id) };
        },
        setTerminalPtyTitle(id: string, title: string): boolean {
            if (titles.get(id) === title) return false;
            titles.set(id, title);
            return true;
        },
    };
}

describe('createTerminalTitleListener', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps the stable Terminal title while persisting the PTY display title separately', () => {
        const terminal: { ptyTitle?: string; title: string } = { title: 'Shell' };
        const store = {
            getTerminal: () => ({ provider: undefined }),
            setTerminalPtyTitle(_id: string, title: string): boolean {
                terminal.ptyTitle = title;
                return true;
            },
        };
        const listen = createTerminalTitleListener('t1', store, () => {});

        listen('zsh caxri');

        expect(terminal).toEqual({ ptyTitle: 'zsh caxri', title: 'Shell' });
    });

    it('persists the first title immediately and broadcasts the Terminal record', () => {
        const store = createStore();
        const events: ServerEvent[] = [];
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
        const events: ServerEvent[] = [];
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
        const events: ServerEvent[] = [];
        const listen = createTerminalTitleListener('t1', store, (event) => events.push(event));
        listen('zsh');
        vi.advanceTimersByTime(TERMINAL_TITLE_THROTTLE_MS);
        listen('zsh');
        vi.advanceTimersByTime(TERMINAL_TITLE_THROTTLE_MS);
        expect(events).toHaveLength(1);
    });

    it('skips persistence and broadcast for a bound Agent Terminal', () => {
        const store = createStore();
        store.providers.set('t1', 'codex');
        const events: ServerEvent[] = [];
        const setTerminalPtyTitle = vi.spyOn(store, 'setTerminalPtyTitle');
        const listen = createTerminalTitleListener('t1', store, (event) => events.push(event));

        listen('codex working');
        vi.advanceTimersByTime(TERMINAL_TITLE_THROTTLE_MS);

        expect(setTerminalPtyTitle).not.toHaveBeenCalled();
        expect(store.titles.size).toBe(0);
        expect(events).toHaveLength(0);
    });

    it('drops a queued Shell title after the Terminal binds an Agent', () => {
        const store = createStore();
        const events: ServerEvent[] = [];
        const listen = createTerminalTitleListener('t1', store, (event) => events.push(event));

        listen('shell-leading');
        listen('agent-trailing');
        store.providers.set('t1', 'claude');
        vi.advanceTimersByTime(TERMINAL_TITLE_THROTTLE_MS);

        expect(store.titles.get('t1')).toBe('shell-leading');
        expect(events).toHaveLength(1);
    });

    it('drops a pending title once cancelled so a retired PTY cannot outlive its Terminal', () => {
        const store = createStore();
        const listen = createTerminalTitleListener('t1', store, () => {});
        listen('old-leading');
        listen('old-trailing');
        listen.cancel();
        // The replacement PTY reuses the durable Terminal ID and writes its own title.
        store.setTerminalPtyTitle('t1', 'restarted');
        vi.advanceTimersByTime(TERMINAL_TITLE_THROTTLE_MS * 4);
        expect(store.titles.get('t1')).toBe('restarted');
    });

    it('ignores a payload that normalizes to nothing', () => {
        const store = createStore();
        const events: ServerEvent[] = [];
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
