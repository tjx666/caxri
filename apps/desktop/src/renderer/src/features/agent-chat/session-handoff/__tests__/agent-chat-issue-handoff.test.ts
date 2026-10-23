import { parseAgentChatSessionHandoff } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    bootstrap: undefined as unknown,
    didSendAgentChatMessage: vi.fn((...[,]: [string, { text: string }]): Promise<boolean> =>
        Promise.resolve(true),
    ),
    dropAgentChatPendingMessage: vi.fn(),
    expireAgentChatPendingMessage: vi.fn(),
    pushToast: vi.fn(),
    showAgentChatPendingMessage: vi.fn(() => 'pending-1'),
}));

vi.mock('../../../../i18n', () => ({ translate: (key: string) => key }));
vi.mock('../../../../stores/selectors', () => ({ getBootstrap: () => mocks.bootstrap }));
vi.mock('../../../../stores/toasts', () => ({ pushToast: mocks.pushToast }));
vi.mock('../../agent-chat-client', () => ({ cachedAgentChatSnapshot: () => {} }));
vi.mock('../../agent-chat-commands', () => ({
    didSendAgentChatMessage: mocks.didSendAgentChatMessage,
}));
vi.mock('../../transcript/agent-chat-pending', () => ({
    dropAgentChatPendingMessage: mocks.dropAgentChatPendingMessage,
    expireAgentChatPendingMessage: mocks.expireAgentChatPendingMessage,
    showAgentChatPendingMessage: mocks.showAgentChatPendingMessage,
}));

import { agentChatIssueHandoffDraft, startAgentChatHandoff } from '../agent-chat-issue-handoff';

const issue = { reference: 'ENG-123', url: 'https://linear.app/example/issue/ENG-123' };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.bootstrap = {
        sessions: [{ id: 'session-1', projectId: 'project-1' }],
        terminals: [{ id: 'chat-1', kind: 'claude', provider: 'claude', sessionId: 'session-1' }],
    };
});

describe('starting an issue in a new Session', () => {
    it('names the issue and its URL as the next task', () => {
        expect(agentChatIssueHandoffDraft(issue)).toBe(
            '/new-session Work on ENG-123: https://linear.app/example/issue/ENG-123',
        );
    });

    it('sends the hand-off instructions from the Chat with a pending message', async () => {
        await startAgentChatHandoff('chat-1', agentChatIssueHandoffDraft(issue));
        expect(mocks.didSendAgentChatMessage).toHaveBeenCalledWith('chat-1', {
            text: expect.stringContaining('--project project-1') as string,
        });
        const text = mocks.didSendAgentChatMessage.mock.lastCall?.[1].text ?? '';
        expect(parseAgentChatSessionHandoff(text)).toEqual({
            note: 'Work on ENG-123: https://linear.app/example/issue/ENG-123',
        });
        expect(mocks.showAgentChatPendingMessage).toHaveBeenCalledOnce();
        expect(mocks.expireAgentChatPendingMessage).toHaveBeenCalledOnce();
        expect(mocks.dropAgentChatPendingMessage).not.toHaveBeenCalled();
    });

    it('drops the pending message when Server Core refuses it', async () => {
        mocks.didSendAgentChatMessage.mockResolvedValueOnce(false);
        await startAgentChatHandoff('chat-1', agentChatIssueHandoffDraft(issue));
        expect(mocks.dropAgentChatPendingMessage).toHaveBeenCalledOnce();
        expect(mocks.expireAgentChatPendingMessage).not.toHaveBeenCalled();
    });

    it('says a Chat with an unknown Session cannot hand off instead of sending the bare command', async () => {
        mocks.bootstrap = { sessions: [], terminals: [] };
        await startAgentChatHandoff('chat-1', agentChatIssueHandoffDraft(issue));
        expect(mocks.didSendAgentChatMessage).not.toHaveBeenCalled();
        expect(mocks.pushToast).toHaveBeenCalledWith('error', 'agentChat.handoff.unavailable');
    });
});
