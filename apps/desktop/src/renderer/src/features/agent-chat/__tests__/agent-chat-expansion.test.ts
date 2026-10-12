import type { AgentChatWorkItem } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    AgentChatExpansionState,
    agentChatItemExpansionKey,
    agentChatSummaryExpansionKey,
    agentChatTurnWorkItems,
    isAgentChatExpanded,
} from '../agent-chat-expansion';
import type { AgentChatTimelineEntry } from '../agent-chat-timeline';

const command = (id: string): AgentChatWorkItem => ({
    id,
    type: 'command',
    command: 'ls',
    output: '',
    status: 'completed',
});

describe('AgentChatExpansionState', () => {
    it('keeps an expanded row open after it merges into a summary group', () => {
        const state = new AgentChatExpansionState();
        // The user opens the live row while it runs.
        state.set(agentChatItemExpansionKey('c2'), true);
        // It settles and joins a summary group the user never touched, which opens to keep it in view.
        const group = [command('c1'), command('c2')];
        expect(state.get(agentChatSummaryExpansionKey(group))).toBeUndefined();
        expect(state.hasExpandedItem(group)).toBe(true);
        expect(state.get(agentChatItemExpansionKey('c2'))).toBe(true);
    });

    it('notifies subscribers only when a choice changes', () => {
        const state = new AgentChatExpansionState();
        const listener = vi.fn();
        const unsubscribe = state.subscribe(listener);
        state.set('a', true);
        state.set('a', true);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        state.set('a', false);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('still notifies later subscribers when one throws', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const state = new AgentChatExpansionState();
        const later = vi.fn();
        state.subscribe(() => {
            throw new Error('row failed');
        });
        state.subscribe(later);
        state.set('a', true);
        expect(later).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith(
            'agentChat.expansion listener failed',
            expect.any(Error),
        );
        consoleError.mockRestore();
    });
});

describe('isAgentChatExpanded', () => {
    it('lets an explicit choice win over the default', () => {
        expect(isAgentChatExpanded(undefined, true)).toBe(true);
        expect(isAgentChatExpanded(false, true)).toBe(false);
        expect(isAgentChatExpanded(true, false)).toBe(true);
    });
});

describe('agentChatTurnWorkItems', () => {
    it('collects the work a finished turn folded', () => {
        const entry: Extract<AgentChatTimelineEntry, { kind: 'turn' }> = {
            kind: 'turn',
            id: 'turn:t1',
            durationMs: 2000,
            status: 'completed',
            entries: [
                { kind: 'work', id: 'work:c1', items: [command('c1')] },
                {
                    kind: 'item',
                    item: { id: 'm1', type: 'agentMessage', text: 'Looking', streaming: false },
                },
                { kind: 'work', id: 'work:c2', items: [command('c2')] },
            ],
        };
        expect(agentChatTurnWorkItems(entry).map((item) => item.id)).toEqual(['c1', 'c2']);
    });
});
