import type { DelegationRetryScheduleOutcome } from '@caxri/protocol';
import { agentDelegationFailureSchema, agentDelegationStatusSchema } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { translate, useLocaleStore } from '../../../i18n';
import { delegationCopy, delegationCopyInput } from '../delegation-copy';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const FAILURES = agentDelegationFailureSchema.options;
const STATUSES = agentDelegationStatusSchema.options;

const copyOf = (input: Parameters<typeof delegationCopy>[0], now = NOW) =>
    delegationCopy(input, now, translate);

describe('delegationCopy', () => {
    afterEach(() => useLocaleStore.setState({ locale: 'en' }));

    it('words every failure on every status the Server can pair it with, with no empty headline', () => {
        for (const status of STATUSES)
            for (const failure of FAILURES) {
                const copy = copyOf({ status, failure, provider: 'codex' });
                expect(copy.headline, `${status}/${failure}`).not.toBe('');
                expect(copy.headline).not.toContain('delegation.');
                expect(copy.headline).not.toContain('{{');
                expect(copy.detail ?? '').not.toContain('{{');
            }
    });

    it('words every failure value for a failed task', () => {
        const headlines = Object.fromEntries(
            FAILURES.map((failure) => [
                failure,
                copyOf({ status: 'failed', failure, provider: 'codex' }).headline,
            ]),
        );
        expect(headlines).toEqual({
            rate_limited: 'Codex usage limit used up',
            quota_exhausted: 'Codex usage limit used up',
            authentication_failed: "Codex isn't signed in",
            output_limit: 'Codex ran out of room',
            startup_not_ready: 'Codex could not start',
            launch_failed: 'Codex could not start',
            startup_waiting: 'Needs your input',
            submission_unconfirmed: 'The task may not have reached Codex',
            provider_failed: 'Codex stopped unexpectedly',
            permission_required: 'Needs your input',
            target_changed: 'Interrupted',
            session_changed: 'Its conversation was replaced',
            human_input: 'You took over this Session',
            host_reset: 'Interrupted',
            result_missing: 'Finished, but its result could not be read',
            payload_overflow: 'Finished, but its result could not be read',
            correlation_missing: 'Finished, but its result could not be read',
            hooks_required: 'Codex needs lifecycle hooks turned on',
            caller_stopped: 'Stopped',
            target_not_ready: 'A follow-up was not started',
            target_busy: 'A follow-up was not started',
        });
    });

    it('shows a reset time only when the Server recorded one that is still ahead', () => {
        const base = { status: 'failed', failure: 'quota_exhausted', provider: 'claude' } as const;
        expect(copyOf({ ...base, failureResetsAt: NOW + 3 * HOUR }).detail).toBe('resets in 3h');
        expect(copyOf({ ...base, failureResetsAt: NOW - 1 }).detail).toBeUndefined();
        expect(copyOf({ ...base, failureResetsAt: NOW }).detail).toBeUndefined();
        expect(copyOf(base).detail).toBeUndefined();
        for (const copy of [copyOf(base), copyOf({ ...base, failureResetsAt: NOW + HOUR })])
            expect(`${copy.headline} ${copy.detail ?? ''}`).not.toMatch(/5-hour|weekly/iu);
    });

    it('moves the reset time with the clock the caller ticks', () => {
        const input = {
            status: 'failed',
            failure: 'rate_limited',
            failureResetsAt: NOW + HOUR,
        } as const;
        expect(copyOf(input, NOW).detail).toBe('resets in 1h');
        expect(copyOf(input, NOW + 30 * 60_000).detail).toBe('resets in 30m');
        expect(copyOf(input, NOW + HOUR).detail).toBeUndefined();
    });

    it('treats a takeover, a stop, and a question as their own states, not failures', () => {
        expect(copyOf({ status: 'human_intervened', failure: 'human_input' })).toMatchObject({
            glyph: 'ordinary',
            headline: 'You took over this Session',
        });
        expect(copyOf({ status: 'interrupted', failure: 'caller_stopped' })).toMatchObject({
            glyph: 'ordinary',
            headline: 'Stopped',
        });
        for (const failure of ['permission_required', 'startup_waiting'] as const) {
            const copy = copyOf({ status: 'blocked', failure });
            expect(copy).toMatchObject({ glyph: 'needsInput', headline: 'Needs your input' });
            expect(`${copy.headline} ${copy.detail}`).not.toMatch(/approv/iu);
        }
    });

    it('reads an answer that could not be read as finished, with the ordinary glyph', () => {
        for (const failure of [
            'result_missing',
            'correlation_missing',
            'payload_overflow',
        ] as const)
            expect(copyOf({ status: 'answer_unavailable', failure })).toMatchObject({
                glyph: 'ordinary',
                headline: 'Finished, but its result could not be read',
                primaryAction: 'openSession',
            });
    });

    it('wears the failed glyph only for a failed task, and offers only opening the Session', () => {
        const glyphs = Object.fromEntries(
            STATUSES.map((status) => [status, copyOf({ status }).glyph]),
        );
        expect(glyphs).toEqual({
            requested: 'running',
            launching: 'running',
            awaiting_ready: 'running',
            submitting: 'running',
            running: 'running',
            collecting: 'running',
            completed: 'ordinary',
            blocked: 'needsInput',
            human_intervened: 'ordinary',
            interrupted: 'ordinary',
            failed: 'failed',
            answer_unavailable: 'ordinary',
        });
        expect(copyOf({ status: 'failed', failure: 'provider_failed' }).primaryAction).toBe(
            'openSession',
        );
        expect(copyOf({ status: 'completed' }).primaryAction).toBe('none');
        expect(copyOf({ status: 'running' }).primaryAction).toBe('none');
        expect(copyOf({ status: 'interrupted', failure: 'caller_stopped' }).primaryAction).toBe(
            'none',
        );
    });

    it('ignores a failure on an active or completed task and handles an entry with no task', () => {
        expect(copyOf({ status: 'running', failure: 'quota_exhausted' }).headline).toBe('Working');
        expect(copyOf({ status: 'completed', failure: 'result_missing' }).headline).toBe(
            'Completed',
        );
        expect(copyOf({}).headline).toBe('No task details');
        expect(copyOf({ status: 'launching', provider: 'claude' }).headline).toBe(
            'Starting Claude',
        );
        expect(copyOf({ status: 'failed' }).headline).toBe('Failed');
    });

    it('falls back to a neutral Agent name when the provider is unknown', () => {
        expect(copyOf({ status: 'failed', failure: 'authentication_failed' }).headline).toBe(
            "The Agent isn't signed in",
        );
    });

    it('words every value in Chinese too, with no raw key left', () => {
        useLocaleStore.setState({ locale: 'zh-CN' });
        for (const status of STATUSES)
            for (const failure of FAILURES) {
                const copy = copyOf({
                    status,
                    failure,
                    provider: 'codex',
                    failureResetsAt: NOW + HOUR,
                });
                expect(copy.headline).not.toContain('delegation.');
                expect(copy.headline).toMatch(/\p{Script=Han}|Codex|Agent/u);
            }
        expect(
            copyOf({ status: 'failed', failure: 'quota_exhausted', provider: 'codex' }),
        ).toMatchObject({
            headline: 'Codex 的额度已用完',
        });
    });
});

describe('delegationCopyInput', () => {
    it('keeps only what decides the copy', () => {
        expect(
            delegationCopyInput({
                failure: 'quota_exhausted',
                failureResetsAt: 5,
                provider: 'codex',
                status: 'failed',
            }),
        ).toEqual({
            failure: 'quota_exhausted',
            failureResetsAt: 5,
            provider: 'codex',
            status: 'failed',
        });
        expect(delegationCopyInput({})).toEqual({});
    });
});

/**
 * A `Record` over the enum, so a new outcome fails to compile here until it is listed, and then fails the test below
 * until both locales word it.
 */
const OUTCOMES: Record<DelegationRetryScheduleOutcome, true> = {
    caller_gone: true,
    target_busy: true,
    target_changed: true,
    human_input: true,
    worktree_gone: true,
    not_retryable: true,
    provider_guarded: true,
    launch_failed: true,
    missed_window: true,
    internal_error: true,
};

describe('delegationCopy with a scheduled retry', () => {
    afterEach(() => useLocaleStore.setState({ locale: 'en' }));

    const failed = { status: 'failed', failure: 'quota_exhausted', provider: 'codex' } as const;

    it('words a pending retry as waiting at its absolute time, with no failure headline', () => {
        const at = new Date(2026, 10, 4, 15, 5).getTime();
        const copy = copyOf({ ...failed, retriedAs: 'n1', retryScheduledFor: at }, at - HOUR);
        expect(copy.glyph).toBe('waiting');
        expect(copy.primaryAction).toBe('none');
        expect(copy.headline).toMatch(/^Retries at 3:05\sPM$/u);
        expect(copy.headline).not.toMatch(/Nov/u);
    });

    it('adds the date when the time is not today', () => {
        const at = new Date(2026, 10, 5, 3, 7).getTime();
        const now = new Date(2026, 10, 4, 22, 0).getTime();
        const copy = copyOf({ ...failed, retriedAs: 'n1', retryScheduledFor: at }, now);
        expect(copy.headline).toMatch(/^Retries at Nov 5, 3:07\sAM$/u);
    });

    it('is not waiting for a started retry or a bare claim without a time', () => {
        expect(copyOf({ ...failed, retriedAs: 'n1' }).glyph).toBe('failed');
        expect(copyOf({ ...failed, retryScheduledFor: NOW }).glyph).toBe('failed');
    });

    it('folds a refusal into the failure detail line and keeps the red failure', () => {
        const copy = copyOf({
            ...failed,
            failureResetsAt: NOW + HOUR,
            retryScheduleOutcome: 'human_input',
        });
        expect(copy.glyph).toBe('failed');
        expect(copy.detail).toBe(
            'resets in 1h · The scheduled retry did not run: you took over this Session',
        );
        expect(copyOf({ ...failed, retryScheduleOutcome: 'missed_window' }).detail).toBe(
            'The scheduled retry did not run: it came due too long ago to start now',
        );
    });

    it('words every outcome in both locales', () => {
        for (const locale of ['en', 'zh-CN'] as const) {
            useLocaleStore.setState({ locale });
            for (const outcome of Object.keys(OUTCOMES) as DelegationRetryScheduleOutcome[]) {
                const detail = copyOf({ ...failed, retryScheduleOutcome: outcome }).detail ?? '';
                expect(detail, `${locale}/${outcome}`).not.toContain('delegation.');
                expect(detail).not.toContain('{{');
                expect(detail.length).toBeGreaterThan(0);
            }
        }
    });
});
