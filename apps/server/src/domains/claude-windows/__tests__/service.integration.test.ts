import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { ClaudeWindowUnavailableReason } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db';
import type { ClaudeAccountProbe, ClaudeWindowSession } from '../probe';
import { ClaudeWindowService } from '../service';

const HOUR = 3_600_000;
const IDENTITY = 'a'.repeat(64);
const originalTimeZone = process.env.TZ;

beforeEach(() => {
    process.env.TZ = 'Asia/Shanghai';
});
afterEach(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
});

/**
 * A fake Claude account: its window starts when a request is sent while it is idle, like the real 5-hour window.
 */
class FakeAccount {
    planType = 'pro';
    windowResetsAt: number | undefined;
    isWeeklyLimitReached = false;
    failure: ClaudeWindowUnavailableReason | undefined;
    sent: number[] = [];
    opened = 0;
    /**
     * When false, a sent request ends without starting a window, as if it never reached the subscription.
     */
    startsWindow = true;
    /**
     * Runs as a request is sent, while its check is still in flight.
     */
    onTrigger: (() => void) | undefined;

    open = (): Promise<ClaudeWindowSession> => {
        this.opened += 1;
        return Promise.resolve({
            read: () => Promise.resolve(this.probe()),
            trigger: () => Promise.resolve(this.trigger()),
            close: () => Promise.resolve(),
        });
    };

    constructor(private readonly clock: { now: number }) {}

    private probe(): ClaudeAccountProbe {
        if (this.failure) return { ok: false, reason: this.failure };
        const resetsAt =
            this.windowResetsAt !== undefined && this.windowResetsAt > this.clock.now
                ? this.windowResetsAt
                : undefined;
        return {
            ok: true,
            reading: {
                identity: IDENTITY,
                planType: this.planType,
                ...(resetsAt !== undefined && { windowResetsAt: resetsAt }),
                isWeeklyLimitReached: this.isWeeklyLimitReached,
            },
        };
    }

    private trigger(): boolean {
        this.sent.push(this.clock.now);
        this.onTrigger?.();
        if (this.startsWindow && !(this.windowResetsAt && this.windowResetsAt > this.clock.now))
            this.windowResetsAt = this.clock.now + 5 * HOUR;
        return true;
    }
}

async function fixture(at: string) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-window-'));
    const clock = { now: new Date(at).getTime() };
    const account = new FakeAccount(clock);
    const write = vi.fn();
    const send = vi.fn();
    let database = new CaxriDatabase(join(directory, 'state.db'));
    const services: ClaudeWindowService[] = [];
    const start = ({ isTimerEnabled = false, isProbeEnabled = true } = {}) => {
        const service = new ClaudeWindowService({
            database,
            logger: { write } as unknown as StructuredLogger,
            send,
            openSession: account.open,
            now: () => clock.now,
            sleep: (ms) => {
                clock.now += ms;
                return Promise.resolve();
            },
            isTimerEnabled,
            isProbeEnabled,
        });
        services.push(service);
        return service;
    };
    onTestFinished(async () => {
        for (const service of services) service.shutdown();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    return {
        clock,
        account,
        write,
        send,
        start,
        /**
         * A restart: Server Core reopens the same database with a fresh service.
         */
        restart: () => {
            database.close();
            database = new CaxriDatabase(join(directory, 'state.db'));
            return start();
        },
        setTime: (text: string) => {
            clock.now = new Date(text).getTime();
        },
        outcomes: () =>
            write.mock.calls
                .filter((call) => call[1] === 'claude_window.outcome')
                .map((call) => (call[2] as { fields: { outcome: string } }).fields.outcome),
    };
}

describe('ClaudeWindowService', () => {
    it('is on by default for Pro and starts the anchored window with one confirmed request', async () => {
        const test = await fixture('2026-10-26T05:00:30');
        const state = await test.start().tick();
        expect(test.account.sent).toEqual([new Date('2026-10-26T05:00:30').getTime()]);
        expect(state).toMatchObject({
            status: 'confirmed',
            account: {
                planType: 'pro',
                keepRolling: true,
                keepRollingIsDefault: true,
                firstWorkdayResetMinutes: 600,
            },
            windowResetsAt: new Date('2026-10-26T10:00:30').getTime(),
            lastOutcome: { outcome: 'trigger_confirmed' },
            nextAnchorAt: new Date('2026-10-27T05:00:00').getTime(),
            wakeTimes: [
                { hour: 5, minute: 0 },
                { hour: 10, minute: 1 },
                { hour: 15, minute: 1 },
                { hour: 20, minute: 1 },
            ],
        });
        expect(state.account?.key).toBe(IDENTITY.slice(0, 16));
        expect(test.send).toHaveBeenCalledWith({ event: 'claudeWindow.changed', payload: {} });
    });

    it('never starts Claude Code when probing is disabled, as in E2E', async () => {
        const test = await fixture('2026-01-05T08:00:00+08:00');
        const service = test.start({ isProbeEnabled: false });
        await expect(service.status(false)).resolves.toMatchObject({
            status: 'unavailable',
            reason: 'claudeNotFound',
        });
        await expect(service.status(true)).resolves.toMatchObject({ reason: 'claudeNotFound' });
        expect(test.account.opened).toBe(0);
    });

    it('is off by default for Max until the user turns it on, and keeps the explicit choice', async () => {
        const test = await fixture('2026-10-26T05:00:30');
        test.account.planType = 'max';
        const service = test.start();
        const off = await service.tick();
        expect(off).toMatchObject({
            status: 'off',
            account: { keepRolling: false, keepRollingIsDefault: true },
        });
        expect(test.account.sent).toEqual([]);
        const on = await service.update({ accountKey: off.account!.key, keepRolling: true });
        expect(on).toMatchObject({
            status: 'confirmed',
            account: { keepRolling: true, keepRollingIsDefault: false },
        });
        expect(test.account.sent).toHaveLength(1);
        await expect(
            service.update({ accountKey: 'other', keepRolling: false }),
        ).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });

    it('renews through the day, skips the renewal that would cover the anchor, and starts the next day fresh', async () => {
        const test = await fixture('2026-10-26T05:00:00');
        const service = test.start();
        for (const time of ['05:00', '10:01', '15:01', '20:01']) {
            test.setTime(`2026-10-26T${time}:00`);
            // eslint-disable-next-line no-await-in-loop -- each check runs at its own time
            await service.tick();
        }
        expect(test.account.sent).toHaveLength(4);
        test.setTime('2026-10-27T01:02:00');
        expect(await service.tick()).toMatchObject({ status: 'waitingForAnchor' });
        expect(test.account.sent).toHaveLength(4);
        test.setTime('2026-10-27T05:00:00');
        await service.tick();
        expect(test.account.sent).toHaveLength(5);
        expect(test.outcomes()).toEqual([
            'trigger_confirmed',
            'trigger_confirmed',
            'trigger_confirmed',
            'trigger_confirmed',
            'renewal_skipped',
            'trigger_confirmed',
        ]);
    });

    it('sends nothing for a window a real request already started', async () => {
        const test = await fixture('2026-10-26T05:03:00');
        test.account.windowResetsAt = new Date('2026-10-26T09:50:00').getTime();
        const state = await test.start().tick();
        expect(test.account.sent).toEqual([]);
        expect(state).toMatchObject({
            status: 'windowActive',
            lastOutcome: { outcome: 'natural_window_started' },
        });
    });

    it('never sends twice for one planned time across repeated runs and a restart', async () => {
        const test = await fixture('2026-10-26T05:00:00');
        test.account.startsWindow = false;
        expect(await test.start().tick()).toMatchObject({
            lastOutcome: { outcome: 'trigger_unverified' },
        });
        test.setTime('2026-10-26T05:20:00');
        await test.start().tick();
        await test.restart().tick();
        expect(test.account.sent).toHaveLength(1);
    });

    it('keeps a change made while a check is still confirming its request', async () => {
        const test = await fixture('2026-10-26T04:00:00');
        const service = test.start();
        const before = await service.tick();
        test.setTime('2026-10-26T05:00:00');
        test.account.startsWindow = false;
        let off: Promise<unknown> | undefined;
        test.account.onTrigger = () => {
            off = service.update({ accountKey: before.account!.key, keepRolling: false });
        };
        await service.tick();
        expect(await off).toMatchObject({ status: 'off', account: { keepRolling: false } });
        expect(await service.status(true)).toMatchObject({ account: { keepRolling: false } });
        expect(test.account.sent).toHaveLength(1);
    });

    it('keeps checking after a first check that could not identify the account', async () => {
        vi.useFakeTimers();
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const test = await fixture('2026-10-26T12:00:00');
        test.account.failure = 'probeFailed';
        test.start({ isTimerEnabled: true });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(test.account.opened).toBe(1);
        test.account.failure = undefined;
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(test.account.opened).toBe(2);
    });

    it('reconciles a time missed while asleep once after waking, and records it', async () => {
        const test = await fixture('2026-10-26T07:40:00');
        const service = test.start();
        const state = await service.tick();
        expect(test.account.sent).toHaveLength(1);
        expect(state.lastOutcome).toMatchObject({
            outcome: 'trigger_confirmed',
            missedPlannedAt: new Date('2026-10-26T05:00:00').getTime(),
        });
        expect(test.outcomes()).toContain('missed_while_asleep');
        test.setTime('2026-10-26T07:45:00');
        await service.tick();
        expect(test.account.sent).toHaveLength(1);
    });

    it('fails closed without sending: weekly limit, unsupported auth, usage unavailable', async () => {
        const test = await fixture('2026-10-26T05:00:00');
        const service = test.start();
        test.account.isWeeklyLimitReached = true;
        expect(await service.tick()).toMatchObject({
            status: 'unavailable',
            reason: 'weeklyLimit',
        });
        test.account.isWeeklyLimitReached = false;
        test.account.failure = 'authUnsupported';
        expect(await service.tick()).toMatchObject({
            status: 'unavailable',
            reason: 'authUnsupported',
            account: { planType: 'pro' },
        });
        test.account.failure = 'usageUnavailable';
        expect(await service.tick()).toMatchObject({
            status: 'unavailable',
            reason: 'usageUnavailable',
        });
        expect(test.account.sent).toEqual([]);
        expect(test.outcomes()).toEqual(['weekly_limit', 'auth_unsupported']);
    });

    it('never sends from a status read, and reuses a recent reading', async () => {
        const test = await fixture('2026-10-26T05:00:00');
        const service = test.start();
        expect(await service.status(false)).toMatchObject({ status: 'waitingForAnchor' });
        await service.status(false);
        expect(test.account.sent).toEqual([]);
        expect(test.account.opened).toBe(1);
        await service.status(true);
        expect(test.account.opened).toBe(2);
    });

    it('reports the background job state with the next status', async () => {
        const test = await fixture('2026-10-26T12:00:00');
        const service = test.start();
        service.reportBackground('registered');
        expect(await service.status(false)).toMatchObject({ background: 'registered' });
    });

    it('logs no email, organization, or full identity', async () => {
        const test = await fixture('2026-10-26T05:00:00');
        await test.start().tick();
        const logged = JSON.stringify(test.write.mock.calls);
        expect(logged).not.toContain(IDENTITY);
        expect(logged).toContain(IDENTITY.slice(0, 16));
    });
});
