import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    clearAgentChatFindHighlights,
    setAgentChatFindHighlights,
} from '../agent-chat-find-highlights';

class FakeHighlight extends Set<object> {}

function range(): AbstractRange {
    return {} as AbstractRange;
}

describe('agent chat find highlights', () => {
    const registry = new Map<string, FakeHighlight>();

    beforeEach(() => {
        registry.clear();
        vi.stubGlobal('Highlight', FakeHighlight);
        vi.stubGlobal('CSS', { highlights: registry });
    });

    afterEach(() => {
        clearAgentChatFindHighlights('a');
        clearAgentChatFindHighlights('b');
        vi.unstubAllGlobals();
    });

    it('paints the active match apart from the others', () => {
        const [first, second, third] = [range(), range(), range()];
        setAgentChatFindHighlights('a', { ranges: [first, second, third], active: second });
        expect([...registry.get('agent-chat-find')!]).toEqual([first, third]);
        expect([...registry.get('agent-chat-find-active')!]).toEqual([second]);
    });

    it('refills the same Highlight instances instead of registering new ones', () => {
        setAgentChatFindHighlights('a', { ranges: [range()], active: undefined });
        const before = registry.get('agent-chat-find');
        const next = range();
        setAgentChatFindHighlights('a', { ranges: [next], active: undefined });
        expect(registry.get('agent-chat-find')).toBe(before);
        expect([...before!]).toEqual([next]);
    });

    it('keeps one owner lit when another closes and unregisters after the last', () => {
        const [one, two] = [range(), range()];
        setAgentChatFindHighlights('a', { ranges: [one], active: undefined });
        setAgentChatFindHighlights('b', { ranges: [two], active: undefined });
        clearAgentChatFindHighlights('b');
        expect([...registry.get('agent-chat-find')!]).toEqual([one]);
        clearAgentChatFindHighlights('a');
        expect(registry.size).toBe(0);
    });
});
