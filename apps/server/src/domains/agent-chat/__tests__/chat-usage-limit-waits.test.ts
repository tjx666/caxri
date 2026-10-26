import type { AgentChatPatchOperation } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ChatUsageLimitWaits } from '../continuation/chat-usage-limit-waits';
import type { UsageLimitNotice } from '../continuation/usage-continuation-stamp';
import { stampUsageContinuations } from '../continuation/usage-continuation-stamp';

const NOW = 1_800_000_000_000;
const HOUR_MS = 3_600_000;

function waits(options: { isGuarded?: boolean; isEnabled?: boolean } = {}) {
    let stored: unknown;
    const write = vi.fn();
    const subject = new ChatUsageLimitWaits({
        database: {
            getAppState: () => stored as never,
            setAppState: (_key, value) => {
                stored = value;
            },
            getTerminal: () => ({ sessionId: 'session-1', surface: 'chat' }) as never,
            getSession: () => ({}) as never,
        },
        logger: { write } as never,
        settings: () => ({ 'agentChat.autoContinueAtUsageLimit': options.isEnabled ?? true }),
        isUsageGuarded: () => options.isGuarded ?? false,
        now: () => NOW,
        random: () => 1,
    });
    return { subject, write, stored: () => stored };
}

function notice(turnId: string, resetsAt: number | undefined): UsageLimitNotice {
    return {
        id: `${turnId}:error`,
        turnId,
        type: 'notice',
        kind: 'error',
        message: "You've hit your limit",
        usageLimit: { window: 'session', ...(resetsAt !== undefined && { resetsAt }) },
    };
}

describe('ChatUsageLimitWaits', () => {
    it('waits for a reset within a day, plus the stagger', () => {
        const { subject, stored } = waits();
        subject.observeFailure('terminal-1', 'claude', notice('turn-1', NOW + 2 * HOUR_MS));
        expect(subject.stateOf('terminal-1', 'turn-1')).toEqual({
            status: 'waiting',
            at: NOW + 2 * HOUR_MS + 120_000,
        });
        expect(subject.stateOf('terminal-1', 'turn-0')).toBeUndefined();
        expect(stored()).toEqual([expect.objectContaining({ turnId: 'turn-1', attempt: 1 })]);
    });

    it.each([
        ['resetUnknown', undefined, false],
        ['resetUnknown', NOW - 1, false],
        ['resetTooFar', NOW + 25 * HOUR_MS, false],
        ['usageGuard', NOW + HOUR_MS, true],
    ] as const)('records why it skips: %s', (reason, resetsAt, isGuarded) => {
        const { subject, write } = waits({ isGuarded });
        subject.observeFailure('terminal-1', 'codex', notice('turn-1', resetsAt));
        expect(subject.stateOf('terminal-1', 'turn-1')).toEqual({ status: 'skipped', reason });
        expect(write).toHaveBeenCalledWith('info', 'usage.auto_continue', {
            fields: expect.objectContaining({ outcome: 'skipped', reason }) as unknown,
        });
        expect(subject.replayNotice('terminal-1')).toBeUndefined();
    });

    it('re-plans a skipped wait when the same turn reports its reset later', () => {
        const { subject } = waits();
        subject.observeFailure('terminal-1', 'codex', notice('turn-1', undefined));
        subject.observeFailure('terminal-1', 'codex', notice('turn-1', NOW + HOUR_MS));
        expect(subject.stateOf('terminal-1', 'turn-1')?.status).toBe('waiting');
    });

    it('stops after the attempt cap when each continuation fails into the limit again', () => {
        const { subject } = waits();
        let previous: string | undefined;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
            const turnId = `turn-${attempt}`;
            if (previous) {
                // What a fired wait leaves behind; the next failure continues its count.
                const record = (
                    subject as unknown as { records: Map<string, { autoContinue: unknown }> }
                ).records.get('terminal-1')!;
                record.autoContinue = { status: 'continued', at: NOW };
            }
            subject.observeFailure('terminal-1', 'claude', notice(turnId, NOW + HOUR_MS));
            previous = turnId;
        }
        expect(subject.stateOf('terminal-1', 'turn-3')).toBeUndefined();
        expect(subject.stateOf('terminal-1', 'turn-4')).toEqual({
            status: 'skipped',
            reason: 'attemptsUsed',
        });
    });

    it('keeps why a wait was skipped when the same notice is seen again', () => {
        const { subject } = waits();
        subject.observeFailure('terminal-1', 'codex', notice('turn-1', NOW + 25 * HOUR_MS));
        subject.observeFailure('terminal-1', 'codex', notice('turn-1', NOW + 25 * HOUR_MS));
        expect(subject.stateOf('terminal-1', 'turn-1')).toEqual({
            status: 'skipped',
            reason: 'resetTooFar',
        });
    });

    it('sends nothing when the wait is cancelled while the plan limits are read', async () => {
        let clock = NOW;
        let stored: unknown;
        const subject = new ChatUsageLimitWaits({
            database: {
                getAppState: () => stored as never,
                setAppState: (_key, value) => {
                    stored = value;
                },
                getTerminal: () => ({ sessionId: 'session-1', surface: 'chat' }) as never,
                getSession: () => ({}) as never,
            },
            logger: { write: vi.fn() } as never,
            settings: () => ({ 'agentChat.autoContinueAtUsageLimit': true }),
            isUsageGuarded: () => false,
            now: () => clock,
            random: () => 0,
        });
        const continueAfterUsageLimit = vi.fn(() => Promise.resolve());
        const session = {
            continueAfterUsageLimit,
            readPlanLimits: () => {
                subject.cancel('terminal-1', 'userInput');
                return Promise.resolve({ windows: [] });
            },
        };
        const state = {
            followUps: { mustWait: () => false },
            projection: { snapshot: { requests: [], items: [], queue: [] } },
        };
        subject.attach({
            states: { get: () => {} } as never,
            deliver: (_terminalId, deliver) => deliver(session as never, state as never),
        });
        subject.observeFailure('terminal-1', 'claude', notice('turn-1', NOW + HOUR_MS));
        clock = NOW + HOUR_MS + 60_000;
        await subject.sweep();
        expect(continueAfterUsageLimit).not.toHaveBeenCalled();
        expect(subject.stateOf('terminal-1', 'turn-1')).toBeUndefined();
    });

    it('does not arm again for a notice whose wait was cancelled, nor while the setting is off', () => {
        const { subject } = waits();
        subject.observeFailure('terminal-1', 'claude', notice('turn-1', NOW + HOUR_MS));
        subject.cancel('terminal-1', 'cancelled', 'turn-1');
        subject.observeFailure('terminal-1', 'claude', notice('turn-1', NOW + HOUR_MS));
        expect(subject.stateOf('terminal-1', 'turn-1')).toBeUndefined();

        const off = waits({ isEnabled: false });
        off.subject.observeFailure('terminal-1', 'claude', notice('turn-1', NOW + HOUR_MS));
        expect(off.subject.stateOf('terminal-1', 'turn-1')).toBeUndefined();
    });
});

describe('stampUsageContinuations', () => {
    const operation = (item: UsageLimitNotice): AgentChatPatchOperation => ({
        op: 'upsertItem',
        item,
    });

    it('stamps, replaces, and removes the automatic continuation', () => {
        const waiting = { status: 'waiting', at: NOW } as const;
        const [stamped] = stampUsageContinuations(
            [operation(notice('turn-1', NOW))],
            () => {},
            () => waiting,
        );
        expect(stamped).toMatchObject({ item: { usageLimit: { autoContinue: waiting } } });

        const [removed] = stampUsageContinuations(
            [stamped],
            () => {},
            () => {},
        );
        expect(removed).toMatchObject({ item: { usageLimit: { window: 'session' } } });
        expect(
            removed.op === 'upsertItem' &&
                removed.item.type === 'notice' &&
                removed.item.usageLimit?.autoContinue,
        ).toBeUndefined();
    });

    it('leaves a batch it does not change as it is', () => {
        const operations = [operation(notice('turn-1', NOW))];
        expect(
            stampUsageContinuations(
                operations,
                () => {},
                () => {},
            ),
        ).toBe(operations);
    });
});
