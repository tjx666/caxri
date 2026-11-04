import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_DELEGATION_REDIRECT_OPERATIONS, parseDelegatedRedirect } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { CaxriDatabase } from '../../db';
import { AgentDelegationService } from '../service';
import type { AgentDelegationServiceOptions } from '../service-options';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const owner = { principal: { kind: 'human-cli', id: 'owner' } } as const;
const LAUNCH = 'chat-launch';
const SECRET_DIRECTION = 'Use the synthetic secret-direction approach instead';

type Steer = NonNullable<AgentDelegationServiceOptions['steer']>;

/**
 * A running Chat child: its launch is bound and its turn has started, so a redirect has a turn to steer.
 */
async function runningChild(overrides: Partial<AgentDelegationServiceOptions> = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-redirect-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(directory);
    const { session, terminal } = database.createSession(project.id, 'claude');
    const start = vi.fn<AgentDispatchService['start']>((_id, _principal, _input, options) => {
        options?.prepared(terminal!);
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['start']>
        >);
    });
    const steer = vi.fn<Steer>(() => Promise.resolve());
    const write = vi.fn<StructuredLogger['write']>();
    const state = { epoch: 0, launch: LAUNCH as string | undefined, isChat: true };
    const service = new AgentDelegationService({
        database,
        dispatch: { start, resume: vi.fn() },
        userDataPath: directory,
        launchSettings: () => ({ executable: 'claude', args: [] }),
        verifyLaunch: () => Promise.resolve(),
        readTranscript: vi.fn(),
        opensAgentsInChat: () => true,
        hasAgentChat: () => true,
        isChatTerminal: () => state.isChat,
        readChatTurn: () => ({ status: 'running' }),
        inputEpoch: () => state.epoch,
        currentLaunchId: () => state.launch,
        steer,
        logger: { write } as unknown as StructuredLogger,
        ...overrides,
    });
    onTestFinished(() => service.close());
    const id = randomUUID();
    await service.create(id, owner, {
        projectId: project.id,
        sessionId: session.id,
        provider: 'claude',
        prompt: 'Synthetic private task',
    });
    const pointer = start.mock.lastCall?.[3]?.initialPrompt ?? '';
    service.bindChatLaunch(terminal!.id, LAUNCH, id);
    service.observe({
        terminalId: terminal!.id,
        launchId: LAUNCH,
        provider: 'claude',
        agentSessionId: database.agentDelegations.get(id)!.providerSessionId,
        agentTurnId: 'turn-1',
        phase: 'turnStarted',
        agentPromptDigest: digest(pointer),
    });
    const redirect = (text = SECRET_DIRECTION, operationId = `op-${randomUUID()}`) =>
        service.redirects.redirect(owner, { delegationId: id, operationId, text });
    const stored = () => database.agentDelegations.get(id)!;
    const reasonOf = async (promise: Promise<unknown>) => {
        try {
            await promise;
        } catch (error) {
            return (error as { details?: { reason?: string } }).details?.reason;
        }
        return;
    };
    return {
        database,
        id,
        redirect,
        reasonOf,
        service,
        state,
        steer,
        stored,
        terminal: terminal!,
        write,
    };
}

describe('DelegationRedirects', () => {
    it('steers the exact turn, keeps the task running, and confirms only after delivery', async () => {
        const f = await runningChild();
        expect(f.stored().receipt.status).toBe('running');

        const receipt = await f.redirect(SECRET_DIRECTION, 'operation-1');

        expect(receipt).toMatchObject({
            delegationId: f.id,
            status: 'running',
            redirectCount: 1,
        });
        expect(receipt.redirectedAt).toBeGreaterThan(0);
        expect(f.steer).toHaveBeenCalledTimes(1);
        const [terminalId, launchId, steer] = f.steer.mock.calls[0];
        expect([terminalId, launchId]).toEqual([f.terminal.id, LAUNCH]);
        expect(steer).toMatchObject({ turnId: 'turn-1', inputEpoch: 0 });
        expect(parseDelegatedRedirect(steer.text)).toEqual({
            delegationId: f.id,
            operationId: 'operation-1',
            text: SECRET_DIRECTION,
        });
        const record = f.stored();
        expect(record.hasHumanIntervention).toBeUndefined();
        expect(record.redirects).toEqual([
            {
                operationId: 'operation-1',
                digest: digest(SECRET_DIRECTION),
                state: 'delivered',
                at: expect.any(Number) as number,
            },
        ]);
        expect(JSON.stringify(record)).not.toContain(SECRET_DIRECTION);
    });

    it('counts each confirmed redirect and answers a repeated operation without sending again', async () => {
        const f = await runningChild();
        await f.redirect('first direction', 'operation-1');
        const second = await f.redirect('second direction', 'operation-2');
        expect(second.redirectCount).toBe(2);

        const replay = await f.redirect('first direction', 'operation-1');

        expect(replay.redirectCount).toBe(2);
        expect(f.steer).toHaveBeenCalledTimes(2);
        expect(await f.reasonOf(f.redirect('other words', 'operation-1'))).toBe('operation_reused');
        expect(f.steer).toHaveBeenCalledTimes(2);
    });

    it('lets only the Agent that owns the task redirect it', async () => {
        const f = await runningChild();
        const stranger = {
            principal: {
                kind: 'agent',
                id: 'stranger',
                endpointId: 'stranger-endpoint',
                generation: 1,
                projectIds: ['project-1'] as string[],
            },
            callerTerminalId: 'other-terminal',
        } as const;

        await expect(
            f.service.redirects.redirect(stranger, {
                delegationId: f.id,
                operationId: 'operation-x',
                text: 'hijack',
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(f.steer).not.toHaveBeenCalled();
    });

    describe('refusals leave the task unchanged', () => {
        it.each([
            [
                'a Terminal child',
                'not_chat',
                (f: Awaited<ReturnType<typeof runningChild>>) => {
                    f.state.isChat = false;
                },
            ],
            [
                'a replaced launch',
                'launch_replaced',
                (f: Awaited<ReturnType<typeof runningChild>>) => {
                    f.state.launch = 'another-launch';
                },
            ],
            [
                'typed input since the task began',
                'human_intervened',
                (f: Awaited<ReturnType<typeof runningChild>>) => {
                    f.state.epoch = 1;
                },
            ],
            [
                'a blocked task',
                'waiting',
                (f: Awaited<ReturnType<typeof runningChild>>) => {
                    const record = f.stored();
                    f.database.agentDelegations.save({
                        ...record,
                        receipt: { ...record.receipt, status: 'blocked' },
                    });
                },
            ],
            [
                'a settled task',
                'not_running',
                (f: Awaited<ReturnType<typeof runningChild>>) => {
                    const record = f.stored();
                    f.database.agentDelegations.save({
                        ...record,
                        receipt: { ...record.receipt, status: 'completed' },
                    });
                },
            ],
            [
                'a taken-over task',
                'human_intervened',
                (f: Awaited<ReturnType<typeof runningChild>>) => {
                    f.service.interruptTerminal(f.terminal.id, true);
                },
            ],
        ])('%s -> %s', async (_label, reason, arrange) => {
            const f = await runningChild();
            arrange(f);
            const before = JSON.stringify(f.stored());

            expect(await f.reasonOf(f.redirect())).toBe(reason);

            expect(JSON.stringify(f.stored())).toBe(before);
            expect(f.steer).not.toHaveBeenCalled();
        });

        it('a task that has not started its turn', async () => {
            const f = await runningChild();
            const record = f.stored();
            f.database.agentDelegations.save({
                ...record,
                receipt: { ...record.receipt, status: 'awaiting_ready' },
            });

            expect(await f.reasonOf(f.redirect())).toBe('not_running');
            expect(f.steer).not.toHaveBeenCalled();
        });

        it('a task that already recorded the most redirects', async () => {
            const f = await runningChild();
            const record = f.stored();
            f.database.agentDelegations.save({
                ...record,
                redirects: Array.from(
                    { length: MAX_DELEGATION_REDIRECT_OPERATIONS },
                    (_, index) => ({
                        operationId: `old-${index}`,
                        digest: digest(`old-${index}`),
                        state: 'delivered' as const,
                        at: 1,
                    }),
                ),
            });

            expect(await f.reasonOf(f.redirect())).toBe('too_many_operations');
            expect(f.steer).not.toHaveBeenCalled();
        });
    });

    describe('when the Chat refuses at the head of its send chain', () => {
        it.each(['turn_changed', 'not_steerable', 'launch_replaced', 'human_intervened'] as const)(
            '%s drops the claim, so the same operation can be tried again',
            async (reason) => {
                const f = await runningChild();
                const { CaxriError } = await import('@caxri/protocol');
                f.steer.mockRejectedValueOnce(
                    new CaxriError('CONFLICT', 'refused', { steerRefusal: reason }),
                );

                expect(await f.reasonOf(f.redirect(SECRET_DIRECTION, 'operation-1'))).toBe(reason);
                expect(f.stored().redirects ?? []).toEqual([]);
                expect(f.stored().receipt.redirectCount).toBeUndefined();

                const receipt = await f.redirect(SECRET_DIRECTION, 'operation-1');
                expect(receipt.redirectCount).toBe(1);
            },
        );
    });

    describe('when delivery is in doubt', () => {
        it('reports delivery_unknown, keeps the claim, and never sends that operation again', async () => {
            const f = await runningChild();
            f.steer.mockRejectedValueOnce(new Error('Codex did not confirm this message in time'));

            expect(await f.reasonOf(f.redirect(SECRET_DIRECTION, 'operation-1'))).toBe(
                'delivery_unknown',
            );
            expect(f.stored().redirects).toMatchObject([
                { operationId: 'operation-1', state: 'unknown' },
            ]);
            expect(f.stored().receipt.redirectCount).toBeUndefined();

            expect(await f.reasonOf(f.redirect(SECRET_DIRECTION, 'operation-1'))).toBe(
                'delivery_unknown',
            );
            expect(f.steer).toHaveBeenCalledTimes(1);

            const next = await f.redirect('a newer direction', 'operation-2');
            expect(next.redirectCount).toBe(1);
        });

        it('treats a claim a Server restart left in flight as unknown', async () => {
            const f = await runningChild();
            const record = f.stored();
            f.database.agentDelegations.save({
                ...record,
                redirects: [
                    {
                        operationId: 'operation-1',
                        digest: digest(SECRET_DIRECTION),
                        state: 'pending',
                        at: 1,
                    },
                ],
            });

            f.service.initialize();

            expect(f.stored().redirects).toMatchObject([{ state: 'unknown' }]);
            expect(await f.reasonOf(f.redirect(SECRET_DIRECTION, 'operation-1'))).toBe(
                'delivery_unknown',
            );
            expect(f.steer).not.toHaveBeenCalled();
        });

        it('waits for a duplicate request that is still being delivered', async () => {
            const f = await runningChild();
            const delivery = Promise.withResolvers<void>();
            f.steer.mockImplementationOnce(() => delivery.promise);

            const first = f.redirect(SECRET_DIRECTION, 'operation-1');
            const duplicate = f.redirect(SECRET_DIRECTION, 'operation-1');
            delivery.resolve();

            expect((await first).redirectCount).toBe(1);
            expect((await duplicate).redirectCount).toBe(1);
            expect(f.steer).toHaveBeenCalledTimes(1);
        });
    });

    it('keeps a takeover that landed while the message was in flight', async () => {
        const f = await runningChild();
        f.steer.mockImplementationOnce(() => {
            f.service.interruptTerminal(f.terminal.id, true);
            return Promise.resolve();
        });

        const receipt = await f.redirect();

        expect(receipt).toMatchObject({ status: 'human_intervened', redirectCount: 1 });
        const record = f.stored();
        expect(record.hasHumanIntervention).toBe(true);
        expect(record.redirects).toMatchObject([{ state: 'delivered' }]);
        expect(await f.reasonOf(f.redirect())).toBe('human_intervened');
    });

    it('logs the outcome with closed values and counts, never the text or the operation ID', async () => {
        const f = await runningChild();
        await f.redirect(SECRET_DIRECTION, 'operation-marker');
        f.state.epoch = 1;
        await f.reasonOf(f.redirect(SECRET_DIRECTION, 'operation-marker-2'));

        const entries = f.write.mock.calls.filter(
            (call) => call[1] === 'agent_delegation.redirected',
        );
        expect(entries.map((call) => call[2]?.fields)).toEqual([
            expect.objectContaining({
                delegationId: f.id,
                outcome: 'delivered',
                reason: null,
                principalKind: 'human-cli',
                textLength: SECRET_DIRECTION.length,
                redirectCount: 1,
            }),
            expect.objectContaining({ outcome: 'refused', reason: 'human_intervened' }),
        ]);
        const serialized = JSON.stringify(f.write.mock.calls);
        expect(serialized).not.toContain(SECRET_DIRECTION);
        expect(serialized).not.toContain('operation-marker');
    });
});
