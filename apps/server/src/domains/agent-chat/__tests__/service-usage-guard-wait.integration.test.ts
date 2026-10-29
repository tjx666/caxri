import { describe, expect, it, vi } from 'vitest';

import { AgentUsageGuards } from '../../usage';
import { ChatUsageContinuation } from '../continuation/chat-usage-continuation';
import { ChatUsageLimitWaits } from '../continuation/chat-usage-limit-waits';
import { fixture } from './chat-service-fixture';

const HOUR_MS = 3_600_000;

/**
 * A Chat under the weekly usage guard whose clock the test moves: `offset` shifts `Date.now()` for the guard and the
 * wait, and the stagger is always its minimum.
 */
function guardedFactory(isEnabled = true) {
    const clock = { offset: 0 };
    const now = () => Date.now() + clock.offset;
    let guards: AgentUsageGuards | undefined;
    return {
        clock,
        expireGuard: () => (guards as unknown as { expire(): void }).expire(),
        usage: (
            database: ConstructorParameters<typeof AgentUsageGuards>[0]['database'] &
                ConstructorParameters<typeof ChatUsageContinuation>[0]['database'],
            logger: ConstructorParameters<typeof AgentUsageGuards>[0]['logger'],
        ) => {
            guards = new AgentUsageGuards({ database, logger, now });
            return new ChatUsageContinuation({
                database,
                logger,
                launchSettings: () => ({ args: [] }) as never,
                resolveExecutable: (kind) => Promise.resolve(`/fake/${kind}`),
                guards,
                createDelegation: vi.fn(),
                discardSession: vi.fn(),
            });
        },
        usageLimitWaits: (
            database: ConstructorParameters<typeof ChatUsageLimitWaits>[0]['database'],
            logger: ConstructorParameters<typeof ChatUsageLimitWaits>[0]['logger'],
        ) =>
            new ChatUsageLimitWaits({
                database,
                logger,
                settings: () => ({ 'agentChat.autoContinueAtUsageLimit': isEnabled }),
                isUsageGuarded: () =>
                    guards?.current('claude') !== undefined ||
                    guards?.current('codex') !== undefined,
                now,
                random: () => 0,
            }),
    };
}

/**
 * Sends a long turn and has the weekly window reach the guard while it runs: Claude Code reports it in a rate-limit
 * event the fake emits, Codex's reaches the guard from its rollout, which the test stands in for.
 */
async function guardRunningTurn(
    chat: Awaited<ReturnType<typeof fixture>>,
    provider: 'claude' | 'codex',
    resetsInHours: number,
) {
    if (provider === 'claude') {
        await chat.service.send(chat.terminal.id, {
            text: resetsInHours > 24 ? 'weekly guard far' : 'weekly guard',
        });
        return;
    }
    await chat.service.send(chat.terminal.id, { text: 'slow' });
    await chat.until((current) => current.activeTurnId !== undefined);
    chat.usage!.observe('codex', {
        windows: [
            {
                scope: 'weekly',
                windowMinutes: 10_080,
                usedPercent: 99.5,
                resetsAt: Date.now() + resetsInHours * HOUR_MS,
            },
        ],
    });
}

describe.each(['claude', 'codex'] as const)(
    '%s Chat stopped by the weekly usage guard',
    (provider) => {
        it('continues after the window resets, once, without a user message', async () => {
            const factory = guardedFactory();
            const chat = await fixture({ provider, ...factory });
            await guardRunningTurn(chat, provider, 2);
            const stopped = await chat.until(
                (current) => current.turns.at(-1)?.stoppedBy === 'usageGuard',
            );
            const turnId = stopped.turns.at(-1)!.id;
            const guard = await chat.until(
                (current) => current.usageGuard?.autoContinue?.status === 'waiting',
            );
            expect(guard.usageGuard).toMatchObject({
                autoContinueTurnId: turnId,
                autoContinue: { status: 'waiting', at: guard.usageGuard!.resetsAt + 30_000 },
            });
            // The wait shows on the Terminal's row, as a 5-hour wait does.
            expect(chat.usageLimitWaits!.waitingAt(chat.terminal.id)).toBe(
                guard.usageGuard!.resetsAt + 30_000,
            );

            // Still guarded: the sweep sends nothing.
            await chat.usageLimitWaits!.sweep();
            expect(chat.client().turns).toHaveLength(1);

            factory.clock.offset = 2 * HOUR_MS + 60_000;
            factory.expireGuard();
            await chat.until((current) => current.usageGuard === undefined);
            // The guard lifted: the stopped turn now carries the wait's notice.
            const notice = chat
                .client()
                .items.find((item) => item.type === 'notice' && item.id === `${turnId}:error`);
            expect(notice).toMatchObject({
                usageLimit: {
                    window: 'weekly',
                    trigger: 'usageGuard',
                    autoContinue: { status: 'waiting' },
                },
            });

            await chat.usageLimitWaits!.sweep();
            const continued = await chat.until(
                (current) => current.turns.length === 2 && current.turns[1].status === 'completed',
            );
            expect(continued.items.filter((item) => item.type === 'userMessage')).toHaveLength(1);
            expect(chat.logWrite).toHaveBeenCalledWith('info', 'usage.auto_continue', {
                fields: expect.objectContaining({
                    provider,
                    window: 'weekly',
                    trigger: 'usageGuard',
                    outcome: 'continued',
                }) as unknown,
            });
        });

        it('does not wait for a reset more than a day away, and says why', async () => {
            const factory = guardedFactory();
            const chat = await fixture({ provider, ...factory });
            await guardRunningTurn(chat, provider, 48);
            const guard = await chat.until(
                (current) => current.usageGuard?.autoContinue?.status === 'skipped',
            );
            expect(guard.usageGuard?.autoContinue).toEqual({
                status: 'skipped',
                reason: 'resetTooFar',
            });
            expect(chat.usageLimitWaits!.waitingAt(chat.terminal.id)).toBeUndefined();
            factory.clock.offset = 49 * HOUR_MS;
            factory.expireGuard();
            await chat.usageLimitWaits!.sweep();
            expect(chat.client().turns).toHaveLength(1);
        });

        it('ends the wait on Cancel and sends nothing after the reset', async () => {
            const factory = guardedFactory();
            const chat = await fixture({ provider, ...factory });
            await guardRunningTurn(chat, provider, 2);
            const guard = await chat.until(
                (current) => current.usageGuard?.autoContinue?.status === 'waiting',
            );
            chat.usageLimitWaits!.cancel(
                chat.terminal.id,
                'cancelled',
                guard.usageGuard!.autoContinueTurnId,
            );
            await chat.until((current) => current.usageGuard?.autoContinue === undefined);
            factory.clock.offset = 2 * HOUR_MS + 60_000;
            factory.expireGuard();
            await chat.usageLimitWaits!.sweep();
            expect(chat.client().turns).toHaveLength(1);
        });

        it('does not wait while the setting is off', async () => {
            const factory = guardedFactory(false);
            const chat = await fixture({ provider, ...factory });
            await guardRunningTurn(chat, provider, 2);
            const guard = await chat.until((current) => current.usageGuard !== undefined);
            await chat.until((current) => current.turns.at(-1)?.stoppedBy === 'usageGuard');
            expect(chat.client().usageGuard?.autoContinue).toBeUndefined();
            expect(guard.usageGuard).toBeDefined();
        });
    },
);
