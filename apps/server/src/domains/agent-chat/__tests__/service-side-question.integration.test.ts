import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

function loggedOutcomes(logWrite: Awaited<ReturnType<typeof fixture>>['logWrite']) {
    return logWrite.mock.calls
        .filter((call) => call[1] === 'agent_chat.side_question')
        .map((call) => call[2]?.fields);
}

describe('AgentChatService side questions', () => {
    it('answers a Claude side question while a turn streams, without touching the conversation', async () => {
        const { service, terminal, until, fakeLog, logWrite } = await fixture({
            provider: 'claude',
        });
        await service.send(terminal.id, { text: 'slow' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);

        const first = await service.askSideQuestion(terminal.id, 'what is 1+1?', []);
        expect(first.response).toBe('Side answer to "what is 1+1?" after 0 earlier');
        const second = await service.askSideQuestion(terminal.id, 'and 2+2?', [
            { question: 'what is 1+1?', response: first.response },
        ]);
        expect(second.response).toBe('Side answer to "and 2+2?" after 1 earlier');

        const snapshot = service.read(terminal.id);
        expect(snapshot.activeTurnId).toBeDefined();
        expect(snapshot.queue ?? []).toHaveLength(0);
        expect(
            snapshot.items.filter((item) => item.type === 'userMessage').map((item) => item.text),
        ).toEqual(['slow']);
        expect(await fakeLog('claude', 'side-questions.jsonl')).toEqual([
            { question: 'what is 1+1?' },
            {
                question: 'and 2+2?',
                history: [{ question: 'what is 1+1?', response: first.response }],
            },
        ]);
        expect(loggedOutcomes(logWrite)).toEqual([
            expect.objectContaining({ outcome: 'answered', reason: null, historyLength: 0 }),
            expect.objectContaining({ outcome: 'answered', reason: null, historyLength: 1 }),
        ]);
        await service.interrupt(terminal.id);
    });

    it('keeps a Chat from being parked while it answers a side question', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'hello' });
        await until((snapshot) => snapshot.turns.length === 1 && !snapshot.activeTurnId);
        expect(service.isSuspendable(terminal.id)).toBe(true);

        const answer = service.askSideQuestion(terminal.id, 'what is 1+1?', []);
        expect(service.isSuspendable(terminal.id)).toBe(false);
        expect(await service.suspendIdle(terminal.id, 'observation')).toBeUndefined();
        await answer;
        expect(service.isSuspendable(terminal.id)).toBe(true);
    });

    it('fails a Claude side question the CLI refuses or answers empty, with a closed reason', async () => {
        const { service, terminal, until, logWrite } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'hello' });
        await until((snapshot) => snapshot.turns.length === 1 && !snapshot.activeTurnId);
        await expect(service.askSideQuestion(terminal.id, 'side-error', [])).rejects.toThrow();
        await expect(service.askSideQuestion(terminal.id, 'side-null', [])).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        expect(loggedOutcomes(logWrite)).toEqual([
            expect.objectContaining({ outcome: 'failed', reason: 'providerError' }),
            expect.objectContaining({ outcome: 'failed', reason: 'empty' }),
        ]);
    });

    it.each(['claude', 'codex'] as const)(
        'never starts an idle %s provider for a side question',
        async (provider) => {
            const { service, terminal, spawnProcess, logWrite } = await fixture({ provider });
            let error: unknown;
            try {
                await service.askSideQuestion(terminal.id, 'anything', []);
            } catch (error_) {
                error = error_;
            }
            expect(error).toBeInstanceOf(CaxriError);
            expect(error).toMatchObject({ code: 'UNAVAILABLE' });
            expect(spawnProcess).not.toHaveBeenCalled();
            expect(loggedOutcomes(logWrite)).toEqual([
                expect.objectContaining({ outcome: 'refused', reason: 'notRunning' }),
            ]);
        },
    );

    it('refuses a Grok side question as unsupported', async () => {
        const { service, terminal, logWrite } = await fixture({ provider: 'grok' });
        service.read(terminal.id);
        await expect(service.askSideQuestion(terminal.id, 'anything', [])).rejects.toMatchObject({
            code: 'VALIDATION',
        });
        expect(loggedOutcomes(logWrite)).toEqual([
            expect.objectContaining({ outcome: 'refused', reason: 'unsupported' }),
        ]);
    });

    it('answers a Codex side question on an ephemeral read-only fork while a turn runs', async () => {
        const { service, terminal, until, fakeLog } = await fixture({ provider: 'codex' });
        await service.send(terminal.id, { text: 'first' });
        await until((snapshot) => snapshot.turns.length === 1 && !snapshot.activeTurnId);
        await service.send(terminal.id, { text: 'slow' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);

        const first = await service.askSideQuestion(terminal.id, 'what is 1+1?', []);
        expect(first.response).toBe('Side answer to "what is 1+1?" after 0 earlier');
        const second = await service.askSideQuestion(terminal.id, 'and 2+2?', [
            { question: 'what is 1+1?', response: first.response },
        ]);
        expect(second.response).toBe('Side answer to "and 2+2?" after 1 earlier');

        const snapshot = service.read(terminal.id);
        expect(snapshot.activeTurnId).toBeDefined();
        expect(snapshot.tasks ?? []).toHaveLength(0);
        expect(
            snapshot.items.filter((item) => item.type === 'userMessage').map((item) => item.text),
        ).toEqual(['first', 'slow']);

        const log = await fakeLog('codex', 'side-threads.jsonl');
        const forks = log.filter((entry) => entry.event === 'fork');
        expect(forks).toHaveLength(2);
        expect(forks[0]).toMatchObject({
            lastTurnId: snapshot.turns[0].id,
            sandbox: 'read-only',
            approvalPolicy: 'never',
        });
        expect(log.filter((entry) => entry.event === 'unsubscribe')).toHaveLength(2);
        await service.interrupt(terminal.id);
    });

    it('fails a Codex side question whose turn failed or said nothing', async () => {
        const { service, terminal, until, logWrite } = await fixture({ provider: 'codex' });
        await service.send(terminal.id, { text: 'hello' });
        await until((snapshot) => snapshot.turns.length === 1 && !snapshot.activeTurnId);
        await expect(service.askSideQuestion(terminal.id, 'side-fail', [])).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        await expect(service.askSideQuestion(terminal.id, 'side-empty', [])).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        expect(loggedOutcomes(logWrite).map((fields) => fields?.reason)).toEqual([
            'providerError',
            'empty',
        ]);
    });
});
