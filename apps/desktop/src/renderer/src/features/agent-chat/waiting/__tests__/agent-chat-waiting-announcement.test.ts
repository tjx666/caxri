import { describe, expect, it } from 'vitest';

import { agentChatWaitingAnnouncementKey } from '../agent-chat-waiting-announcement';

describe('agentChatWaitingAnnouncementKey', () => {
    it('separates questions from approvals', () => {
        expect(agentChatWaitingAnnouncementKey('question')).toBe(
            'agentChat.waiting.announceQuestion',
        );
        expect(agentChatWaitingAnnouncementKey('terminal')).toBe(
            'agentChat.waiting.announceTerminal',
        );
        for (const kind of ['command', 'fileChange', 'tool'] as const)
            expect(agentChatWaitingAnnouncementKey(kind)).toBe(
                'agentChat.waiting.announceApproval',
            );
    });
});
