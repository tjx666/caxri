import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    bootstrap: undefined as unknown,
    didSelectSession: vi.fn((): Promise<boolean> => Promise.resolve(true)),
    didSendAgentChatMessage: vi.fn((): Promise<boolean> => Promise.resolve(true)),
    request: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
    sessionState: undefined as unknown,
}));

vi.mock('../../../../i18n', () => ({ translate: (key: string) => key }));
vi.mock('../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));
vi.mock('../../../../stores/selectors', () => ({
    getBootstrap: () => mocks.bootstrap,
    getSessionState: () => mocks.sessionState,
}));
vi.mock('../../../../stores/toasts', () => ({
    describeFailureNotice: (error: unknown) => ({
        message: error instanceof Error ? error.message : 'failed',
    }),
    tryCommand: async (...[, run]: [string, () => Promise<unknown>]): Promise<unknown> => {
        try {
            return await run();
        } catch {
            return undefined;
        }
    },
}));
vi.mock('../../../../stores/workbench', () => ({ refreshWorkbench: vi.fn() }));
vi.mock('../../../session/session-commands', () => ({ didSelectSession: mocks.didSelectSession }));
vi.mock('../../agent-chat-commands', () => ({
    didSendAgentChatMessage: mocks.didSendAgentChatMessage,
}));

import {
    askAgentChatSideQuestion,
    convertAgentChatSideChatToSession,
    discardAgentChatSideChat,
    discardAgentChatSideChatIfChatGone,
    isAgentChatSideChatBusyFor,
    retryAgentChatSideQuestion,
    useAgentChatSideChatStore,
} from '../agent-chat-side-chat-commands';

const terminalId = 'chat-1';
const thread = (): ReturnType<typeof useAgentChatSideChatStore.getState>['threads'][string] =>
    useAgentChatSideChatStore.getState().threads[terminalId];

function bootstrap(selectedSessionId = 'session-1') {
    return {
        selectedSessionId,
        sessions: [{ id: 'session-1', projectId: 'project-1' }],
        terminals: [{ id: terminalId, kind: 'claude', sessionId: 'session-1' }],
    };
}

beforeEach(() => {
    useAgentChatSideChatStore.setState({ threads: {} });
    mocks.request.mockReset();
    mocks.didSelectSession.mockClear();
    mocks.didSendAgentChatMessage.mockClear();
    mocks.bootstrap = bootstrap();
    mocks.sessionState = {};
});

describe('askAgentChatSideQuestion', () => {
    it('records the answer and sends earlier answers as history on the follow-up', async () => {
        mocks.request.mockResolvedValueOnce({ response: 'first answer' });
        await askAgentChatSideQuestion(terminalId, ' first? ');
        mocks.request.mockResolvedValueOnce({ response: 'second answer' });
        await askAgentChatSideQuestion(terminalId, 'second?');

        expect(mocks.request).toHaveBeenNthCalledWith(1, 'agentChat.askSideQuestion', {
            terminalId,
            question: 'first?',
            history: [],
        });
        expect(mocks.request).toHaveBeenNthCalledWith(2, 'agentChat.askSideQuestion', {
            terminalId,
            question: 'second?',
            history: [{ question: 'first?', response: 'first answer' }],
        });
        expect(thread()?.map(({ status }) => status)).toEqual(['answered', 'answered']);
    });

    it('keeps a failure on the exchange and retries it with the answers before it', async () => {
        mocks.request.mockResolvedValueOnce({ response: 'ok' });
        await askAgentChatSideQuestion(terminalId, 'one');
        mocks.request.mockRejectedValueOnce(new Error('Start the Chat before asking'));
        await askAgentChatSideQuestion(terminalId, 'two');
        expect(thread()?.[1]).toMatchObject({
            status: 'failed',
            error: 'Start the Chat before asking',
        });

        mocks.request.mockResolvedValueOnce({ response: 'now answered' });
        await retryAgentChatSideQuestion(terminalId, thread()?.[1]?.id ?? '');
        expect(thread()?.[1]).toMatchObject({ status: 'answered', response: 'now answered' });
        expect(mocks.request).toHaveBeenLastCalledWith('agentChat.askSideQuestion', {
            terminalId,
            question: 'two',
            history: [{ question: 'one', response: 'ok' }],
        });
    });

    it('holds a second question while one is pending and ignores blank text', async () => {
        const answer = Promise.withResolvers<unknown>();
        mocks.request.mockImplementationOnce(() => answer.promise);
        const pending = askAgentChatSideQuestion(terminalId, 'slow');
        await askAgentChatSideQuestion(terminalId, 'too soon');
        await askAgentChatSideQuestion(terminalId, ' '.repeat(3));
        expect(thread()).toHaveLength(1);
        answer.resolve({ response: 'done' });
        await pending;
        expect(thread()?.[0]?.status).toBe('answered');
    });
});

describe('discardAgentChatSideChatIfChatGone', () => {
    beforeEach(() => {
        mocks.request.mockResolvedValue({ response: 'a' });
    });

    it('keeps the thread when its tab closed but its Chat is still there', async () => {
        await askAgentChatSideQuestion(terminalId, 'q');
        discardAgentChatSideChatIfChatGone(terminalId);
        expect(thread()).toHaveLength(1);

        mocks.bootstrap = bootstrap('other-session');
        discardAgentChatSideChatIfChatGone(terminalId);
        expect(thread()).toHaveLength(1);
    });

    it('discards it once the Chat is gone', async () => {
        await askAgentChatSideQuestion(terminalId, 'q');
        mocks.bootstrap = { ...bootstrap(), terminals: [] };
        discardAgentChatSideChatIfChatGone(terminalId);
        expect(thread()).toBeUndefined();
    });

    it('forgets the side chat of a Chat deleted while its tab was closed on the next question', async () => {
        await askAgentChatSideQuestion(terminalId, 'q');
        mocks.bootstrap = {
            ...bootstrap(),
            terminals: [{ id: 'chat-2', kind: 'claude', sessionId: 'session-1' }],
        };
        await askAgentChatSideQuestion('chat-2', 'other');
        expect(thread()).toBeUndefined();
        expect(useAgentChatSideChatStore.getState().threads['chat-2']).toHaveLength(1);
    });
});

describe('convertAgentChatSideChatToSession', () => {
    it('creates a same-provider Chat in the same Project, seeds it, and discards the thread', async () => {
        mocks.request.mockResolvedValueOnce({ response: 'because' });
        await askAgentChatSideQuestion(terminalId, 'why?');
        mocks.request.mockResolvedValueOnce({
            session: { id: 'session-2' },
            terminal: { id: 'chat-2' },
        });

        await convertAgentChatSideChatToSession(terminalId);

        expect(mocks.request).toHaveBeenLastCalledWith('session.create', {
            projectId: 'project-1',
            defaultAgent: 'claude',
            surface: 'chat',
        });
        expect(mocks.didSelectSession).toHaveBeenCalledWith('session-2');
        expect(mocks.didSendAgentChatMessage).toHaveBeenCalledWith('chat-2', {
            text: expect.stringContaining('Q: why?\n\nA: because') as string,
        });
        expect(thread()).toBeUndefined();
    });

    it('keeps the thread when the new Chat did not accept the seed, and does nothing without answers', async () => {
        await convertAgentChatSideChatToSession(terminalId);
        expect(mocks.request).not.toHaveBeenCalled();

        mocks.request.mockResolvedValueOnce({ response: 'a' });
        await askAgentChatSideQuestion(terminalId, 'q');
        mocks.request.mockResolvedValueOnce({
            session: { id: 'session-2' },
            terminal: { id: 'chat-2' },
        });
        mocks.didSendAgentChatMessage.mockResolvedValueOnce(false);
        await convertAgentChatSideChatToSession(terminalId);
        expect(thread()).toHaveLength(1);
        discardAgentChatSideChat(terminalId);
    });
});

describe('isAgentChatSideChatBusyFor', () => {
    it('is true only while a question of the Chat is pending', async () => {
        expect(isAgentChatSideChatBusyFor(terminalId)).toBe(false);
        const answer = Promise.withResolvers<unknown>();
        mocks.request.mockReturnValueOnce(answer.promise);
        const asking = askAgentChatSideQuestion(terminalId, 'slow?');
        expect(isAgentChatSideChatBusyFor(terminalId)).toBe(true);
        expect(isAgentChatSideChatBusyFor('other-chat')).toBe(false);
        answer.resolve({ response: 'done' });
        await asking;
        expect(isAgentChatSideChatBusyFor(terminalId)).toBe(false);
    });
});
