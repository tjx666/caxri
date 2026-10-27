import type { AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    agentChatMessageEditAvailability,
    agentChatMessageEditCaption,
    isAgentChatMessageClipped,
} from '../agent-chat-message-edit';

const snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'operation' | 'turns'> = {
    items: [
        { id: 'first', type: 'userMessage', turnId: 'turn-1', text: 'Fix the build' },
        { id: 'reply-1', type: 'agentMessage', turnId: 'turn-1', text: 'Done.', streaming: false },
        {
            id: 'steer',
            type: 'userMessage',
            turnId: 'turn-1',
            text: 'and lint',
            delivery: 'steered',
        },
        {
            id: 'picture',
            type: 'userMessage',
            turnId: 'turn-2',
            text: 'Like this',
            images: [{}],
        },
        { id: 'last', type: 'userMessage', turnId: 'turn-3', text: 'Ship it' },
    ],
    turns: [
        { id: 'turn-1', status: 'completed' },
        { id: 'turn-2', status: 'completed' },
        { id: 'turn-3', status: 'completed' },
    ],
};

describe('agentChatMessageEditAvailability', () => {
    it('offers an edit of a message that started its turn, counting the turns it replaces', () => {
        expect(agentChatMessageEditAvailability(snapshot, 'first', translate)).toEqual({
            canEdit: true,
            removedTurns: 3,
        });
        expect(agentChatMessageEditAvailability(snapshot, 'last', translate)).toEqual({
            canEdit: true,
            removedTurns: 1,
        });
    });

    it("refuses a message with images, a steer, a reply, and any message while a turn runs, in Desktop's words", () => {
        const reason = (itemId: string, state = snapshot) => {
            const result = agentChatMessageEditAvailability(state, itemId, translate);
            return result.canEdit ? undefined : result.reason;
        };
        expect(reason('picture')).toBe('Messages with images cannot be edited');
        expect(reason('steer')).toBe('This message cannot be edited');
        expect(reason('reply-1')).toBe('This message cannot be edited');
        expect(reason('first', { ...snapshot, activeTurnId: 'turn-3' })).toBe(
            'Stop the running turn to edit from here',
        );
        expect(reason('first', { ...snapshot, operation: 'compacting' })).toBe(
            'Stop the running turn to edit from here',
        );
    });
});

describe('agentChatMessageEditCaption', () => {
    it('says how many turns sending the edit replaces', () => {
        expect(agentChatMessageEditCaption(1, translate)).toBe(
            'Editing an earlier message · its turn will be replaced',
        );
        expect(agentChatMessageEditCaption(3, translate)).toBe(
            'Editing an earlier message · 3 turns will be replaced',
        );
    });
});

describe('isAgentChatMessageClipped', () => {
    it('recognizes a message the phone holds only the tail of', () => {
        expect(isAgentChatMessageClipped('…the tail')).toBe(true);
        expect(isAgentChatMessageClipped('whole message')).toBe(false);
    });
});
