import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatEditAvailability,
    agentChatEditCaption,
    agentChatEditRemovedTurns,
} from '../agent-chat-edit';

type EditSnapshot = Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'>;

function user(id: string, turnId: string, images?: Array<{ thumbnail?: string }>): AgentChatItem {
    return { id, type: 'userMessage', text: id, turnId, ...(images && { images }) };
}

const settled: EditSnapshot = {
    items: [user('u1', 't1'), user('u2', 't2', [{}]), user('u3', 't3')],
    turns: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'completed' },
        { id: 't3', status: 'completed' },
    ],
};

describe('Agent Chat edit from here', () => {
    it('enables the action for a settled message and explains every refusal', () => {
        expect(agentChatEditAvailability(settled, 'u1')).toEqual({ canEdit: true });
        expect(agentChatEditAvailability(settled, 'u2')).toEqual({
            canEdit: false,
            reason: 'Messages with images cannot be edited',
        });
        expect(agentChatEditAvailability({ ...settled, activeTurnId: 't3' }, 'u1')).toEqual({
            canEdit: false,
            reason: 'Stop the running turn to edit from here',
        });
    });

    it('counts the turns an edit replaces, and ends an edit whose message is gone', () => {
        const edit = { itemId: 'u1', restoreFiles: false, previousDraft: '' };
        expect(agentChatEditRemovedTurns(settled, edit)).toBe(3);
        expect(agentChatEditRemovedTurns({ ...settled, activeTurnId: 't3' }, edit)).toBe(3);
        expect(agentChatEditRemovedTurns({ items: [], turns: [] }, edit)).toBeUndefined();
        expect(agentChatEditCaption(1)).toBe(
            'Editing an earlier message · its turn will be replaced',
        );
        expect(agentChatEditCaption(3)).toBe(
            'Editing an earlier message · 3 turns will be replaced',
        );
    });
});
