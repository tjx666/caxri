import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { parseArguments } from '../watch-ci-arguments';
import type { CommitRun } from '../watch-ci-sha';
import {
    DOWNSTREAM_GRACE_MS,
    followCommit,
    followSupersedingRuns,
    isSuccessfulConclusion,
    nextFollowStep,
    parseWorkflowRunChains,
    resolveCommitSha,
} from '../watch-ci-sha';

const chains = new Map([['CI', ['Release macOS']]]);
const run = (overrides: Partial<CommitRun>): CommitRun => ({
    conclusion: '',
    id: '1',
    name: 'CI',
    status: 'in_progress',
    ...overrides,
});

describe('--sha argument parsing', () => {
    it('accepts full and abbreviated SHAs', () => {
        expect(parseArguments(['--sha', 'abc1234'])).toEqual({ quiet: false, sha: 'abc1234' });
        expect(parseArguments(['--sha', 'A'.repeat(40), '--quiet']).sha).toBe('A'.repeat(40));
    });

    it('rejects a missing operand and a non-hexadecimal value', () => {
        expect(() => parseArguments(['--sha'])).toThrow(/requires a value/);
        expect(() => parseArguments(['--sha', 'main'])).toThrow(/hexadecimal/);
        expect(() => parseArguments(['--sha', 'abc12'])).toThrow(/hexadecimal/);
    });

    it('rejects combining --sha with another selector', () => {
        for (const other of [
            ['--pr', '3'],
            ['--run', '9'],
            ['--branch', 'x'],
            ['--workflow', 'CI'],
        ]) {
            expect(() => parseArguments(['--sha', 'abc1234', ...other])).toThrow(
                /cannot be combined/,
            );
        }
    });
});

describe('parseWorkflowRunChains', () => {
    it('maps upstream names to downstream workflow names', () => {
        const documents = [
            { name: 'Release macOS', on: { workflow_run: { workflows: ['CI', 'Other'] } } },
            { name: 'CI', on: { push: {} } },
            { name: 'Nightly', on: { workflow_run: { workflows: ['CI'] } } },
            { on: { workflow_run: { workflows: ['CI'] } } },
            'not a workflow',
        ];
        expect(parseWorkflowRunChains(documents)).toEqual(
            new Map([
                ['CI', ['Release macOS', 'Nightly']],
                ['Other', ['Release macOS']],
            ]),
        );
    });

    it('finds the release workflow chain in the repository workflow files', () => {
        const release: unknown = parse(
            readFileSync(join(import.meta.dirname, '../../.github/workflows/release.yml'), 'utf8'),
        );
        expect(parseWorkflowRunChains([release]).get('CI')).toContain('Release macOS');
    });
});

describe('isSuccessfulConclusion', () => {
    it('counts success and all-skipped runs only', () => {
        expect(isSuccessfulConclusion('success')).toBe(true);
        expect(isSuccessfulConclusion('skipped')).toBe(true);
        for (const bad of ['failure', 'cancelled', 'timed_out', '']) {
            expect(isSuccessfulConclusion(bad)).toBe(false);
        }
    });
});

describe('nextFollowStep', () => {
    const base = { chains, nowMs: 1_000_000, waitedMs: 0 };

    it('waits for the first run, then times out after ten minutes', () => {
        expect(nextFollowStep({ ...base, runs: [] })).toEqual({ kind: 'wait', waitingFor: [] });
        expect(nextFollowStep({ ...base, runs: [], waitedMs: 600_000 })).toEqual({
            kind: 'timeout',
        });
    });

    it('waits while any run is still active', () => {
        expect(nextFollowStep({ ...base, runs: [run({})] })).toEqual({
            kind: 'wait',
            waitingFor: ['CI'],
        });
    });

    it('waits for the downstream inside the grace window after a successful upstream', () => {
        const ci = run({
            completedAtMs: base.nowMs - 1_000,
            conclusion: 'success',
            status: 'completed',
        });
        expect(nextFollowStep({ ...base, runs: [ci] })).toEqual({
            kind: 'wait',
            waitingFor: ['Release macOS'],
        });
    });

    it('stops waiting for an absent downstream once the grace window has passed', () => {
        const ci = run({
            completedAtMs: base.nowMs - DOWNSTREAM_GRACE_MS,
            conclusion: 'success',
            status: 'completed',
        });
        expect(nextFollowStep({ ...base, runs: [ci] })).toEqual({ kind: 'done' });
    });

    it('does not wait for the downstream of a failed upstream', () => {
        const ci = run({ completedAtMs: base.nowMs, conclusion: 'failure', status: 'completed' });
        expect(nextFollowStep({ ...base, runs: [ci] })).toEqual({ kind: 'done' });
    });

    it('waits for the downstream run itself, then finishes when it completes', () => {
        const ci = run({ completedAtMs: base.nowMs, conclusion: 'success', status: 'completed' });
        const release = run({ id: '2', name: 'Release macOS', status: 'queued' });
        expect(nextFollowStep({ ...base, runs: [ci, release] })).toEqual({
            kind: 'wait',
            waitingFor: ['Release macOS'],
        });
        expect(
            nextFollowStep({
                ...base,
                runs: [ci, { ...release, conclusion: 'skipped', status: 'completed' }],
            }),
        ).toEqual({ kind: 'done' });
    });
});

describe('followCommit', () => {
    const wait = async () => {};
    const completed = (id: string, name: string, conclusion: string) => ({
        conclusion,
        id,
        name,
        status: 'completed',
    });

    it('watches a downstream run that appears after the upstream completes and reports failures', async () => {
        const listRuns = vi
            .fn()
            .mockResolvedValueOnce([completed('1', 'CI', 'success')])
            .mockResolvedValue([
                completed('1', 'CI', 'success'),
                completed('2', 'Release macOS', 'failure'),
            ]);
        const isRunGood = vi.fn((id: string) => Promise.resolve(id === '1'));
        const failed = await followCommit('sha', isRunGood, { chains, listRuns, wait });
        expect(isRunGood.mock.calls.map(([id]) => id)).toEqual(['1', '2']);
        expect(failed.map((entry) => entry.name)).toEqual(['Release macOS']);
    });

    it('returns no failures when every run succeeded', async () => {
        const listRuns = vi.fn().mockResolvedValue([completed('1', 'Guards', 'success')]);
        expect(
            await followCommit('sha', () => Promise.resolve(true), { chains, listRuns, wait }),
        ).toEqual([]);
    });

    it('retries a dropped listing and gives up after repeated failures', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const listRuns = vi
            .fn()
            .mockRejectedValueOnce(new Error('EOF'))
            .mockResolvedValue([completed('1', 'Guards', 'success')]);
        expect(
            await followCommit('sha', () => Promise.resolve(true), { chains, listRuns, wait }),
        ).toEqual([]);
        const broken = vi.fn().mockRejectedValue(new Error('offline'));
        await expect(
            followCommit('sha', () => Promise.resolve(true), { chains, listRuns: broken, wait }),
        ).rejects.toThrow('offline');
    });
});

describe('resolveCommitSha', () => {
    const wait = async () => {};
    const full = 'a'.repeat(40);

    it('retries a dropped connection, then gives up after repeated failures', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const lookup = vi.fn().mockRejectedValueOnce(new Error('EOF')).mockResolvedValue(full);
        expect(await resolveCommitSha('aaaa', { lookup, wait })).toBe(full);
        expect(lookup).toHaveBeenCalledTimes(2);
        const broken = vi.fn().mockRejectedValue(new Error('EOF'));
        await expect(resolveCommitSha('aaaa', { lookup: broken, wait })).rejects.toThrow('EOF');
        expect(broken).toHaveBeenCalledTimes(5);
    });

    it('fails at once on an HTTP 4xx answer or a malformed SHA', async () => {
        const missing = vi
            .fn()
            .mockRejectedValue(new Error('gh: No commit found for SHA: aaaa (HTTP 422)'));
        await expect(resolveCommitSha('aaaa', { lookup: missing, wait })).rejects.toThrow(
            'HTTP 422',
        );
        expect(missing).toHaveBeenCalledTimes(1);
        const malformed = vi.fn().mockResolvedValue('');
        await expect(resolveCommitSha('aaaa', { lookup: malformed, wait })).rejects.toThrow(
            'could not resolve commit aaaa',
        );
    });
});

describe('followSupersedingRuns', () => {
    const cancelled = run({ conclusion: 'cancelled', id: '10', status: 'completed' });
    const noWait = () => Promise.resolve();
    const origin = (conclusion: string) => ({
        branch: 'main',
        conclusion,
        event: 'push',
        workflowId: '7',
    });

    it('follows the newer push run that cancelled this one when its commit contains this commit', async () => {
        const isRunGood = vi.fn(() => Promise.resolve(true));
        const result = await followSupersedingRuns(cancelled, 'a'.repeat(40), isRunGood, {
            contains: (base, head) =>
                Promise.resolve(base === 'a'.repeat(40) && head === 'b'.repeat(40)),
            listPushRuns: () =>
                Promise.resolve([
                    { id: '11', sha: 'b'.repeat(40) },
                    { id: '10', sha: 'a'.repeat(40) },
                ]),
            readRun: () => Promise.resolve(origin('cancelled')),
        });
        expect(result).toBe(true);
        expect(isRunGood).toHaveBeenCalledWith('11');
    });

    it('chases a superseding run that was itself cancelled, and reports a real failure as failed', async () => {
        const conclusions = new Map([
            ['10', 'cancelled'],
            ['11', 'cancelled'],
            ['12', 'failure'],
        ]);
        const isRunGood = vi.fn((runId: string) => Promise.resolve(runId === 'never'));
        const result = await followSupersedingRuns(cancelled, 'a', isRunGood, {
            contains: () => Promise.resolve(true),
            listPushRuns: () =>
                Promise.resolve([
                    { id: '12', sha: 'c' },
                    { id: '11', sha: 'b' },
                ]),
            readRun: (runId) => Promise.resolve(origin(conclusions.get(runId) ?? '')),
        });
        expect(result).toBe(false);
        expect(isRunGood.mock.calls).toEqual([['12']]);
    });

    it('leaves a run alone when it was not cancelled by a newer push of the same branch', async () => {
        const isRunGood = vi.fn(() => Promise.resolve(true));
        const notSuperseded = await followSupersedingRuns(cancelled, 'a', isRunGood, {
            contains: () => Promise.resolve(false),
            listPushRuns: () => Promise.resolve([{ id: '11', sha: 'b' }]),
            readRun: () => Promise.resolve(origin('cancelled')),
            wait: noWait,
        });
        const manuallyCancelled = await followSupersedingRuns(cancelled, 'a', isRunGood, {
            listPushRuns: () => Promise.resolve([{ id: '10', sha: 'a' }]),
            readRun: () => Promise.resolve(origin('cancelled')),
            wait: noWait,
        });
        expect([notSuperseded, manuallyCancelled]).toEqual([undefined, undefined]);
        expect(isRunGood).not.toHaveBeenCalled();
    });

    it('keeps listing until the superseding run appears, since GitHub can list it after the cancellation', async () => {
        const listings = [
            [{ id: '10', sha: 'a' }],
            [{ id: '10', sha: 'a' }],
            [{ id: '11', sha: 'b' }],
        ];
        const listPushRuns = vi.fn(() => Promise.resolve(listings.shift() ?? []));
        const isRunGood = vi.fn(() => Promise.resolve(true));
        const result = await followSupersedingRuns(cancelled, 'a', isRunGood, {
            contains: () => Promise.resolve(true),
            listPushRuns,
            readRun: () => Promise.resolve(origin('cancelled')),
            wait: noWait,
        });
        expect(result).toBe(true);
        expect(listPushRuns).toHaveBeenCalledTimes(3);
        expect(isRunGood).toHaveBeenCalledWith('11');
    });
});
