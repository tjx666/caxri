import type { AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CreateForkSession } from '../chat-fork';
import { fixture } from './chat-service-fixture';

type Provider = 'claude' | 'codex' | 'grok';

function userTexts(snapshot: AgentChatSnapshot): string[] {
    return snapshot.items.flatMap((item) => (item.type === 'userMessage' ? [item.text] : []));
}

function isSettled(snapshot: AgentChatSnapshot, turns: number): boolean {
    return (
        snapshot.turns.length === turns &&
        !snapshot.activeTurnId &&
        snapshot.turns.every((turn) => turn.status === 'completed')
    );
}

/**
 * Starts a Chat with three completed turns, `first`, `second`, and `third`, and a session creator that opens a fork the
 * way `session.create` does: a new Session's Chat Terminal, bound to the forked Agent Session before it starts.
 */
async function threeTurns(provider: Provider) {
    const context = await fixture({ provider });
    for (const [index, text] of ['first', 'second', 'third'].entries()) {
        // eslint-disable-next-line no-await-in-loop -- each turn must finish before the next is sent
        await context.service.send(context.terminal.id, { text });
        // eslint-disable-next-line no-await-in-loop -- see above
        await context.until((snapshot) => isSettled(snapshot, index + 1));
    }
    const messageId = (text: string): string => {
        const item = context
            .client()
            .items.find((candidate) => candidate.type === 'userMessage' && candidate.text === text);
        if (!item) throw new Error(`The ${text} message is missing`);
        return item.id;
    };
    const createSession = vi.fn<CreateForkSession>(
        ({ projectId, provider: kind, cwd, agentSessionId }) => {
            const { session } = context.database.createSession(projectId, null);
            const terminal = context.database.createTerminal(session.id, kind, cwd, 'chat');
            if (agentSessionId)
                context.database.rebindAgentSession(terminal.id, kind, agentSessionId);
            return Promise.resolve({ sessionId: session.id, terminalId: terminal.id });
        },
    );
    return { ...context, messageId, createSession };
}

describe('AgentChatService fork', () => {
    it.each<Provider>(['claude', 'codex', 'grok'])(
        'forks a %s conversation before an earlier message into a new Chat',
        async (provider) => {
            const { service, terminal, messageId, createSession } = await threeTurns(provider);
            const forked = await service.fork(terminal.id, messageId('second'), createSession);

            expect(createSession).toHaveBeenCalledOnce();
            const [opened] = createSession.mock.calls[0];
            expect(opened.provider).toBe(provider);
            expect(opened.agentSessionId).toBeTypeOf('string');
            await service.restart(forked.terminalId);
            expect(userTexts(service.read(forked.terminalId))).toEqual(['first']);
            // The source Chat keeps every turn.
            expect(userTexts(service.read(terminal.id))).toEqual(['first', 'second', 'third']);
        },
    );

    it('opens an empty Chat when the first message is forked, without asking the provider', async () => {
        const { service, terminal, messageId, createSession, fakeLog } = await threeTurns('codex');
        await service.fork(terminal.id, messageId('first'), createSession);
        expect(createSession).toHaveBeenCalledWith(
            expect.objectContaining({ agentSessionId: undefined }),
        );
        expect(await fakeLog('codex', 'thread-forks.jsonl')).toEqual([]);
    });

    it('refuses while a turn is running and creates nothing', async () => {
        const { service, terminal, until, messageId, createSession, logWrite } =
            await threeTurns('codex');
        await service.send(terminal.id, { text: 'slow' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await expect(
            service.fork(terminal.id, messageId('second'), createSession),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(createSession).not.toHaveBeenCalled();
        const forked = logWrite.mock.calls.find(([, event]) => event === 'agent_chat.forked');
        expect(forked?.[2]?.fields).toMatchObject({ outcome: 'refused', code: 'CONFLICT' });
    });
});
