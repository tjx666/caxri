import type { AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { ChatUsageLimitWaits } from '../continuation/chat-usage-limit-waits';
import { fixture } from './chat-service-fixture';

const HOUR_MS = 3_600_000;

/**
 * A wait whose clock the test moves: `offset` shifts `Date.now()`, and the stagger is always its minimum.
 */
function waitsFactory(isEnabled = true) {
    const clock = { offset: 0 };
    return {
        clock,
        usageLimitWaits: (
            database: ConstructorParameters<typeof ChatUsageLimitWaits>[0]['database'],
            logger: ConstructorParameters<typeof ChatUsageLimitWaits>[0]['logger'],
        ) =>
            new ChatUsageLimitWaits({
                database,
                logger,
                settings: () => ({ 'agentChat.autoContinueAtUsageLimit': isEnabled }),
                isUsageGuarded: () => false,
                now: () => Date.now() + clock.offset,
                random: () => 0,
            }),
    };
}

function usageLimitNotice(snapshot: AgentChatSnapshot, turnId: string) {
    const notice = snapshot.items.find((item) => item.id === `${turnId}:error`);
    return notice?.type === 'notice' ? notice.usageLimit : undefined;
}

async function failOnLimit(chat: Awaited<ReturnType<typeof fixture>>) {
    await chat.service.send(chat.terminal.id, { text: 'usage exhausted' });
    const snapshot = await chat.until((current) => current.turns.at(-1)?.status === 'failed');
    return snapshot.turns.at(-1)!.id;
}

describe('AgentChatService automatic continuation after a usage limit', () => {
    it('waits for the reset, then continues a Claude Chat without a user message', async () => {
        const { clock, usageLimitWaits } = waitsFactory();
        const chat = await fixture({ provider: 'claude', usageLimitWaits });
        const turnId = await failOnLimit(chat);
        const waiting = usageLimitNotice(chat.client(), turnId);
        // The fixture's limit resets two hours out; the wait adds the minimum stagger.
        expect(waiting?.autoContinue).toEqual({
            status: 'waiting',
            at: waiting!.resetsAt! + 30_000,
        });

        await chat.usageLimitWaits!.sweep();
        expect(chat.client().turns).toHaveLength(1);

        clock.offset = 2 * HOUR_MS + 60_000;
        await chat.usageLimitWaits!.sweep();
        const continued = await chat.until(
            (current) => current.turns.length === 2 && current.turns[1].status === 'completed',
        );
        expect(usageLimitNotice(continued, turnId)?.autoContinue).toMatchObject({
            status: 'continued',
        });
        expect(continued.items.filter((item) => item.type === 'userMessage')).toHaveLength(1);
        expect(chat.logWrite).toHaveBeenCalledWith('info', 'usage.auto_continue', {
            fields: expect.objectContaining({
                provider: 'claude',
                window: 'session',
                outcome: 'continued',
                attempt: 1,
            }) as unknown,
        });

        // The continuation prompt stays hidden when the history replays from Claude Code's transcript.
        const restarted = await chat.restartServer();
        await expect
            .poll(() => restarted.read(chat.terminal.id).turns.length)
            .toBeGreaterThanOrEqual(2);
        const userTexts = restarted
            .read(chat.terminal.id)
            .items.flatMap((item) => (item.type === 'userMessage' ? [item.text] : []));
        expect(userTexts).toEqual(['usage exhausted']);
    });

    it('continues a Codex Chat with a turn that has no input', async () => {
        const { clock, usageLimitWaits } = waitsFactory();
        const chat = await fixture({ provider: 'codex', usageLimitWaits });
        const turnId = await failOnLimit(chat);
        expect(usageLimitNotice(chat.client(), turnId)?.autoContinue?.status).toBe('waiting');

        clock.offset = 2 * HOUR_MS + 60_000;
        await chat.usageLimitWaits!.sweep();
        const continued = await chat.until(
            (current) => current.turns.length === 2 && current.turns[1].status === 'completed',
        );
        expect(usageLimitNotice(continued, turnId)?.autoContinue?.status).toBe('continued');
        expect(continued.items.filter((item) => item.type === 'userMessage')).toHaveLength(1);
    });

    it('moves a Codex wait to the later reset when the window is still used up at the reported one', async () => {
        const { clock, usageLimitWaits } = waitsFactory();
        const chat = await fixture({ provider: 'codex', usageLimitWaits });
        await chat.service.send(chat.terminal.id, { text: 'usage exhausted, reset moved' });
        const failed = await chat.until((current) => current.turns.at(-1)?.status === 'failed');
        const turnId = failed.turns.at(-1)!.id;
        const reported = usageLimitNotice(failed, turnId)!.resetsAt!;

        clock.offset = 2 * HOUR_MS + 60_000;
        await chat.usageLimitWaits!.sweep();
        // No turn ran into the still used-up window; the wait now ends three hours past the reported reset.
        await expect
            .poll(() => {
                const moved = usageLimitNotice(chat.client(), turnId)?.autoContinue;
                return moved?.status === 'waiting' && moved.at - reported;
            })
            .toBe(3 * HOUR_MS + 30_000);
        expect(chat.client().turns).toHaveLength(1);
        expect(chat.logWrite).toHaveBeenCalledWith('info', 'usage.auto_continue', {
            fields: expect.objectContaining({
                provider: 'codex',
                window: 'session',
                outcome: 'rescheduled',
            }) as unknown,
        });

        clock.offset = 5 * HOUR_MS + 60_000;
        await chat.usageLimitWaits!.sweep();
        await chat.until(
            (current) => current.turns.length === 2 && current.turns[1].status === 'completed',
        );
    });

    it('ends the wait on Cancel', async () => {
        const { clock, usageLimitWaits } = waitsFactory();
        const chat = await fixture({ provider: 'claude', usageLimitWaits });
        const turnId = await failOnLimit(chat);
        const waits = chat.usageLimitWaits!;

        expect(() => waits.cancel(chat.terminal.id, 'cancelled', 'other-turn')).toThrow(
            expect.objectContaining({ code: 'CONFLICT' }),
        );
        waits.cancel(chat.terminal.id, 'cancelled', turnId);
        await chat.until(
            (current) => usageLimitNotice(current, turnId)?.autoContinue === undefined,
        );
        clock.offset = 2 * HOUR_MS + 60_000;
        await waits.sweep();
        expect(chat.client().turns).toHaveLength(1);
        expect(chat.logWrite).toHaveBeenCalledWith('info', 'usage.auto_continue', {
            fields: expect.objectContaining({
                outcome: 'cancelled',
                reason: 'cancelled',
            }) as unknown,
        });
    });

    it('offers Continue instead of continuing when the reset passed long ago', async () => {
        const { clock, usageLimitWaits } = waitsFactory();
        const chat = await fixture({ provider: 'claude', usageLimitWaits });
        const turnId = await failOnLimit(chat);
        clock.offset = 3 * HOUR_MS;
        await chat.usageLimitWaits!.sweep();
        const missed = await chat.until(
            (current) => usageLimitNotice(current, turnId)?.autoContinue?.status === 'missed',
        );
        expect(missed.turns).toHaveLength(1);

        await chat.usageLimitWaits!.continueNow(chat.terminal.id, turnId);
        const continued = await chat.until(
            (current) => current.turns.length === 2 && current.turns[1].status === 'completed',
        );
        expect(usageLimitNotice(continued, turnId)?.autoContinue).toBeUndefined();
    });

    it('keeps a wait across a Server Core restart and shows its notice after the replay', async () => {
        const { usageLimitWaits } = waitsFactory();
        const chat = await fixture({ provider: 'claude', usageLimitWaits });
        const turnId = await failOnLimit(chat);
        const reloaded = new ChatUsageLimitWaits({
            database: chat.database,
            logger: { write: () => {} } as never,
            settings: () => ({ 'agentChat.autoContinueAtUsageLimit': true }),
            isUsageGuarded: () => false,
        });
        expect(reloaded.stateOf(chat.terminal.id, turnId)?.status).toBe('waiting');
        expect(reloaded.replayNotice(chat.terminal.id)).toMatchObject({
            id: `${turnId}:error`,
            usageLimit: { window: 'session' },
        });

        // Claude Code's transcript keeps no failed-turn notice; the replay gets it back from the wait.
        const restarted = await chat.restartServer();
        restarted.read(chat.terminal.id);
        await expect
            .poll(
                () =>
                    usageLimitNotice(restarted.read(chat.terminal.id), turnId)?.autoContinue
                        ?.status,
            )
            .toBe('waiting');
    });

    it('does not wait while the setting is off', async () => {
        const { usageLimitWaits } = waitsFactory(false);
        const chat = await fixture({ provider: 'claude', usageLimitWaits });
        const turnId = await failOnLimit(chat);
        expect(usageLimitNotice(chat.client(), turnId)?.autoContinue).toBeUndefined();
    });
});
