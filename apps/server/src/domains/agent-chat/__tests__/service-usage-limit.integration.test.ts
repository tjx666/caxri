import type { AgentChatSnapshot, AgentDelegationReceipt } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { AgentUsageGuards } from '../../usage';
import { ChatUsageContinuation } from '../continuation/chat-usage-continuation';
import { fixture } from './chat-service-fixture';

type ContinuationOptions = ConstructorParameters<typeof ChatUsageContinuation>[0];

function usageFactory(
    createDelegation = vi.fn<ContinuationOptions['createDelegation']>(),
    discardSession = vi.fn<ContinuationOptions['discardSession']>(),
) {
    return {
        createDelegation,
        discardSession,
        usage: (
            database: ConstructorParameters<typeof AgentUsageGuards>[0]['database'] &
                ConstructorParameters<typeof ChatUsageContinuation>[0]['database'],
            logger: ConstructorParameters<typeof AgentUsageGuards>[0]['logger'],
        ) =>
            new ChatUsageContinuation({
                database,
                logger,
                launchSettings: () => ({ args: [] }) as never,
                resolveExecutable: (kind) =>
                    kind === 'grok'
                        ? Promise.reject(new Error('not installed'))
                        : Promise.resolve(`/fake/${kind}`),
                guards: new AgentUsageGuards({ database, logger }),
                createDelegation,
                discardSession,
            }),
    };
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

function failedNotice(snapshot: AgentChatSnapshot) {
    const turn = snapshot.turns.at(-1);
    const notice = snapshot.items.find((item) => item.id === `${turn?.id}:error`);
    return notice?.type === 'notice' ? notice : undefined;
}

describe('AgentChatService usage limits', () => {
    it('marks a Claude turn that failed on a used-up 5-hour limit', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'usage exhausted' });
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'failed');
        expect(failedNotice(snapshot)?.usageLimit).toEqual({
            window: 'session',
            resetsAt: expect.any(Number) as number,
        });
        // Claude Code's synthetic "You've hit your session limit" reply is the failure, not an answer.
        expect(snapshot.items.filter((item) => item.type === 'agentMessage')).toEqual([]);
    });

    it('tells an ordinary Claude failure apart from a used-up limit', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'fail' });
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'failed');
        expect(failedNotice(snapshot)).toBeDefined();
        expect(failedNotice(snapshot)?.usageLimit).toBeUndefined();
    });

    it('marks a Codex turn that failed with usageLimitExceeded', async () => {
        const { service, terminal, until } = await fixture({ provider: 'codex' });
        await service.send(terminal.id, { text: 'usage exhausted' });
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'failed');
        expect(failedNotice(snapshot)?.usageLimit).toEqual({
            window: 'session',
            resetsAt: expect.any(Number) as number,
        });
    });

    it('continues a failed turn in another Agent from a deterministic package, once per turn', async () => {
        const receipt = { sessionId: 'session-new' } as AgentDelegationReceipt;
        const { createDelegation, usage } = usageFactory(
            vi.fn<ContinuationOptions['createDelegation']>().mockResolvedValue(receipt),
        );
        const chat = await fixture({ provider: 'claude', usage });
        await chat.service.send(chat.terminal.id, { text: 'usage exhausted' });
        const snapshot = await chat.until((current) => current.turns.at(-1)?.status === 'failed');
        const turnId = snapshot.turns.at(-1)!.id;

        expect(await chat.usage!.targets(chat.terminal.id)).toEqual([
            { provider: 'claude', unavailable: 'current' },
            { provider: 'codex' },
            { provider: 'grok', unavailable: 'notInstalled' },
        ]);
        await expect(
            chat.usage!.continueIn(chat.terminal.id, 'grok', turnId),
        ).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        await expect(
            chat.usage!.continueIn(chat.terminal.id, 'codex', 'other-turn'),
        ).rejects.toMatchObject({ code: 'CONFLICT' });

        const result = await chat.usage!.continueIn(chat.terminal.id, 'codex', turnId);
        expect(result).toEqual({
            sessionId: 'session-new',
            delegationId: expect.stringMatching(UUID) as string,
        });
        const [id, authority, request] = createDelegation.mock.calls[0];
        expect(id).toBe(result.delegationId);
        expect(authority).toEqual({
            principal: { kind: 'desktop', id: 'usage-continuation', generation: 1 },
            callerTerminalId: chat.terminal.id,
        });
        expect(request).toMatchObject({
            newSession: true,
            handoff: true,
            provider: 'codex',
            title: expect.stringMatching(/^Continued: /u) as string,
        });
        expect(request.prompt).toContain('Claude hit its 5-hour usage limit');
        expect(request.prompt).toContain('## Latest request\n\nusage exhausted');
        expect(chat.logWrite).toHaveBeenCalledWith('info', 'usage.continuation', {
            fields: expect.objectContaining({
                source: 'claude',
                provider: 'codex',
                trigger: 'usageLimit',
                outcome: 'created',
            }) as unknown,
        });
    });

    it('removes the empty Session of a continuation whose Agent never launched', async () => {
        const receipt = { sessionId: 'session-new', status: 'failed' } as AgentDelegationReceipt;
        const { discardSession, usage } = usageFactory(
            vi.fn<ContinuationOptions['createDelegation']>().mockResolvedValue(receipt),
        );
        const chat = await fixture({ provider: 'claude', usage });
        await chat.service.send(chat.terminal.id, { text: 'usage exhausted' });
        const snapshot = await chat.until((current) => current.turns.at(-1)?.status === 'failed');
        await expect(
            chat.usage!.continueIn(chat.terminal.id, 'codex', snapshot.turns.at(-1)!.id),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        expect(discardSession).toHaveBeenCalledWith('session-new');
        expect(chat.logWrite).toHaveBeenCalledWith('warn', 'usage.continuation', {
            fields: expect.objectContaining({ outcome: 'failed', code: 'UNAVAILABLE' }) as unknown,
        });
    });

    it('blocks every ordinary request at the weekly guard and grants one hand-off', async () => {
        const { usage } = usageFactory();
        const chat = await fixture({ provider: 'claude', usage });
        await chat.service.send(chat.terminal.id, { text: 'weekly nearly used' });
        const guarded = await chat.until((current) => current.usageGuard !== undefined);
        expect(guarded.usageGuard).toMatchObject({
            provider: 'claude',
            usedPercent: 99.5,
            handoff: 'available',
        });

        await expect(chat.service.send(chat.terminal.id, { text: 'hello' })).rejects.toMatchObject({
            code: 'USAGE_LIMITED',
        });
        await expect(chat.service.runCommand(chat.terminal.id, 'compact')).rejects.toMatchObject({
            code: 'USAGE_LIMITED',
        });
        await expect(
            chat.service.askSideQuestion(chat.terminal.id, 'what now?', []),
        ).rejects.toMatchObject({ code: 'USAGE_LIMITED' });

        chat.usage!.generateHandoff(chat.terminal.id);
        expect(() => chat.usage!.generateHandoff(chat.terminal.id)).toThrow(
            expect.objectContaining({ code: 'CONFLICT' }),
        );
        const handedOff = await chat.until(
            (current) => current.usageGuard?.document?.status === 'generated',
        );
        expect(handedOff.usageGuard).toMatchObject({
            handoff: 'used',
            document: { text: expect.stringContaining('hand-off document') as string },
        });
        expect(chat.logWrite.mock.calls.map((call) => call[2]?.fields?.outcome)).toEqual(
            expect.arrayContaining(['armed', 'refused', 'handoff_started', 'handoff_generated']),
        );
    });
});
