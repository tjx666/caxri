import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    agentChatEditAvailability,
    agentChatEditCaption,
    agentChatEditRemovedTurns,
    agentChatForkAvailability,
    agentChatRestoreAvailability,
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
            reason: 'agentChat.edit.imagesUnsupported',
        });
        expect(agentChatEditAvailability({ ...settled, activeTurnId: 't3' }, 'u1')).toEqual({
            canEdit: false,
            reason: 'agentChat.edit.stopToEdit',
        });
    });

    it('forks a message with images too, but not while a turn runs', () => {
        expect(agentChatForkAvailability(settled, 'u2')).toEqual({ canFork: true });
        expect(agentChatForkAvailability({ ...settled, activeTurnId: 't3' }, 'u1')).toEqual({
            canFork: false,
            reason: 'agentChat.edit.stopToFork',
        });
        expect(agentChatForkAvailability(settled, 'missing')).toEqual({
            canFork: false,
            reason: 'agentChat.edit.cannotFork',
        });
    });

    it('restores code to any settled message, images included, and explains a running turn', () => {
        expect(agentChatRestoreAvailability(settled, 'u1')).toEqual({ restoredTurns: 3 });
        expect(agentChatRestoreAvailability(settled, 'u2')).toEqual({ restoredTurns: 2 });
        expect(agentChatRestoreAvailability({ ...settled, activeTurnId: 't3' }, 'u3')).toEqual({
            reason: 'agentChat.edit.stopToRestore',
        });
        expect(agentChatRestoreAvailability(settled, 'gone')).toEqual({
            reason: 'agentChat.edit.cannotRestore',
        });
    });

    it('counts the turns an edit replaces, and ends an edit whose message is gone', () => {
        const edit = { itemId: 'u1', restoreFiles: false, previousDraft: '', appendedDraft: '' };
        expect(agentChatEditRemovedTurns(settled, edit)).toBe(3);
        expect(agentChatEditRemovedTurns({ ...settled, activeTurnId: 't3' }, edit)).toBe(3);
        expect(agentChatEditRemovedTurns({ items: [], turns: [] }, edit)).toBeUndefined();
        expect(agentChatEditCaption(1, translate)).toBe(
            'Editing an earlier message · its turn will be replaced',
        );
        expect(agentChatEditCaption(3, translate)).toBe(
            'Editing an earlier message · 3 turns will be replaced',
        );
    });
});
