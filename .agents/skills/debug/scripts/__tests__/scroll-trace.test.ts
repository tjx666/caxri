import { describe, expect, it } from 'vitest';

import type { ScrollTraceEntry } from '../scroll-trace';
import {
    formatScrollTrace,
    isUnexpectedReveal,
    parseEvalJson,
    parseScrollTraceCommand,
} from '../scroll-trace';

const scroll = (overrides: Partial<Extract<ScrollTraceEntry, { kind: 'scroll' }>>) =>
    ({
        kind: 'scroll',
        t: 0,
        top: 0,
        hidden: false,
        sinceInput: null,
        scrollHeight: 3000,
        clientHeight: 700,
        ...overrides,
    }) satisfies ScrollTraceEntry;

describe('scroll-trace', () => {
    it('reads one action and the packaged and json flags', () => {
        expect(parseScrollTraceCommand(['read', '--packaged', '--json'])).toEqual({
            action: 'read',
            isJson: true,
            isPackaged: true,
        });
        expect(() => parseScrollTraceCommand(['watch'])).toThrow(/start, read, reset/u);
        expect(() => parseScrollTraceCommand(['read', '--verbose'])).toThrow(/Unknown option/u);
    });

    it('flags a scroll with the scrollbar shown only when the user gave no input just before it', () => {
        expect(isUnexpectedReveal(scroll({ sinceInput: null }))).toBe(true);
        expect(isUnexpectedReveal(scroll({ sinceInput: 5000 }))).toBe(true);
        expect(isUnexpectedReveal(scroll({ sinceInput: 30 }))).toBe(false);
        expect(isUnexpectedReveal(scroll({ hidden: true }))).toBe(false);
    });

    it('prints entries relative to the first one and counts the reveals', () => {
        const output = formatScrollTrace([
            {
                kind: 'write',
                t: 1000,
                call: 'scrollTop',
                from: 0,
                to: 2750,
                hidden: true,
                caller: 'pin',
            },
            {
                kind: 'resize',
                t: 1137,
                row: 'div[agentChatReply]',
                from: 1642,
                to: 1644,
                top: 2750,
            },
            scroll({ t: 1137, top: 2752 }),
        ]);
        expect(output.split('\n')).toEqual([
            '+     0ms write  scrollTop 0->2750 scrollbar=hidden by pin',
            '+   137ms resize 1642->1644 top=2750 div[agentChatReply]',
            '+   137ms REVEAL top=2752 scrollbar=shown sinceInput=- height=3000/700',
            '1 unexpected scrollbar reveal(s) in 3 entries',
        ]);
    });

    it('decodes the doubly encoded eval output', () => {
        expect(parseEvalJson('"[{\\"kind\\":\\"scroll\\"}]"\n')).toEqual([{ kind: 'scroll' }]);
        expect(parseEvalJson('"null"')).toBeNull();
    });
});
