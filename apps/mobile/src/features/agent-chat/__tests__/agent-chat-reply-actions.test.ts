import type { AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    agentChatReplyFork,
    agentChatReplyRetry,
    agentChatReplyTime,
    agentChatSourceFavicon,
    agentChatSourceHost,
} from '../agent-chat-reply-actions';

type Snapshot = Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'operation' | 'turns'>;

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
    items: [
        { id: 'u1', turnId: 't1', type: 'userMessage', text: 'One' },
        { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Reply one', streaming: false },
        { id: 'u2', turnId: 't2', type: 'userMessage', text: 'Two' },
        { id: 'a2', turnId: 't2', type: 'agentMessage', text: 'Reply two', streaming: false },
    ],
    turns: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'completed' },
    ],
    ...overrides,
});

describe('agentChatReplyTime', () => {
    const now = new Date(2026, 9, 18, 12, 0).getTime();

    it('names today and yesterday, and dates older replies', () => {
        expect(
            agentChatReplyTime(new Date(2026, 9, 18, 9, 5).getTime(), now, 'en', translate),
        ).toBe('Today 9:05 AM');
        expect(
            agentChatReplyTime(new Date(2026, 9, 17, 22, 26).getTime(), now, 'en', translate),
        ).toBe('Yesterday 10:26 PM');
        expect(
            agentChatReplyTime(new Date(2026, 9, 3, 17, 59).getTime(), now, 'en', translate),
        ).toBe('Oct 3 5:59 PM');
        expect(
            agentChatReplyTime(new Date(2025, 9, 3, 17, 59).getTime(), now, 'en', translate),
        ).toBe('Oct 3, 2025 5:59 PM');
    });
});

describe('agentChatReplyFork', () => {
    it('forks an earlier reply before the next turn’s message and the latest reply whole', () => {
        expect(agentChatReplyFork(snapshot(), 't1', translate)).toEqual({
            itemId: 'u2',
            availability: { canRun: true },
        });
        expect(agentChatReplyFork(snapshot(), 't2', translate)).toEqual({
            availability: { canRun: true },
        });
    });

    it('waits for a running turn to stop', () => {
        expect(
            agentChatReplyFork(snapshot({ activeTurnId: 't3' }), 't1', translate).availability,
        ).toEqual({ canRun: false, reason: translate('chat.reply.stopToFork') });
    });
});

describe('agentChatReplyRetry', () => {
    it('sends the turn’s own message again, refused while a turn runs', () => {
        expect(agentChatReplyRetry(snapshot(), 't2', translate)).toEqual({
            itemId: 'u2',
            availability: { canRun: true },
        });
        expect(
            agentChatReplyRetry(snapshot({ activeTurnId: 't3' }), 't2', translate)?.availability,
        ).toEqual({ canRun: false, reason: translate('chat.edit.stopToEdit') });
        expect(agentChatReplyRetry(snapshot(), 'missing', translate)).toBeUndefined();
    });
});

describe('agentChatSourceHost', () => {
    it('names a page by its host without www', () => {
        expect(agentChatSourceHost('https://www.example.com/a?b=1')).toBe('example.com');
        expect(agentChatSourceHost('not a url')).toBe('not a url');
    });
});

describe('agentChatSourceFavicon', () => {
    it('loads an HTTPS page site icon and never a plain-HTTP or malformed one', () => {
        expect(agentChatSourceFavicon('https://www.example.com/a?b=1')).toBe(
            'https://www.example.com/favicon.ico',
        );
        expect(agentChatSourceFavicon('http://192.168.1.10/admin')).toBeUndefined();
        expect(agentChatSourceFavicon('not a url')).toBeUndefined();
    });
});
