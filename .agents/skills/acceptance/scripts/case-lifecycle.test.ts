import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    forceCompleteCaseLifecycle,
    markCaseLifecycleReady,
    repairCaseLifecycle,
} from './case-lifecycle';
import type { InitializeReportInput } from './report';
import { finalizeReport, initializeReport } from './report';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/**
 * The production path guard requires fixtures under the real project `.records/` root.
 */
const RECORDS_ROOT = join(PROJECT_ROOT, '.records');
const TEST_ROOT = join(RECORDS_ROOT, '__test__', `acceptance-case-lifecycle-${process.pid}`);
const acceptanceRoots: string[] = [];
const requirement = 'Caxri 终端应完整填满工作区。';
const plan = [
    {
        category: '终端布局',
        expected: '终端视口周围不出现应用背景色条。',
        id: 'terminal-layout',
        method: '启动隔离的 Caxri 并检查稳定后的终端布局。',
        requiredEvidence: ['screenshot'],
        surface: 'desktop',
        title: '终端内容填满工作区',
        verifier: 'agent',
    },
] satisfies InitializeReportInput['plan'];

interface ReportFixture {
    cases: Array<Record<string, unknown>>;
    [key: string]: unknown;
}

function parseReport(raw: string): ReportFixture {
    const parsed: unknown = JSON.parse(raw);
    if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('cases' in parsed) ||
        !Array.isArray(parsed.cases)
    ) {
        throw new Error('Invalid report fixture');
    }
    return parsed as ReportFixture;
}

async function reportDirectory(): Promise<string> {
    await mkdir(TEST_ROOT, { recursive: true });
    const root = await mkdtemp(join(TEST_ROOT, 'case-'));
    acceptanceRoots.push(root);
    return join(root, 'round-1');
}

async function initialize(directory: string, input: Partial<InitializeReportInput> = {}) {
    return initializeReport({
        directory,
        entry: '在 Caxri Electron 中打开首个 Session 终端。',
        plan: [...plan],
        requirement,
        title: '验收 Caxri 终端布局',
        ...input,
    });
}

afterEach(async () => {
    const directories = [...acceptanceRoots];
    acceptanceRoots.length = 0;
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
});

afterAll(async () => {
    await rm(TEST_ROOT, { force: true, recursive: true });
});

describe('Acceptance case lifecycle repair', () => {
    it('lets the stop adapter complete a launch its launcher never finished, exactly once', async () => {
        const directory = await reportDirectory();
        await initialize(directory);
        const launchId = await beginCaseLifecycle(directory, {
            caseId: 'terminal-layout',
            profileIdentity: 'killed-profile',
            stateIsolation: { mode: 'isolated' },
        });
        await markCaseLifecycleReady(directory, { caseId: 'terminal-layout', launchId });

        await expect(
            forceCompleteCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                cleanupCompleted: true,
                cleanupRequested: true,
                launchId,
                reason: 'launcher force-killed',
                source: 'stop-electron',
            }),
        ).resolves.toBe('completed');
        // The launcher won the race on a second attempt: the genuine record is never overwritten.
        await expect(
            forceCompleteCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                cleanupCompleted: false,
                cleanupRequested: true,
                launchId,
                reason: 'later attempt',
                source: 'stop-electron',
            }),
        ).resolves.toBe('already_completed');
        await expect(
            forceCompleteCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                cleanupCompleted: true,
                cleanupRequested: true,
                launchId: 'unknown-launch',
                reason: 'x',
                source: 'stop-electron',
            }),
        ).rejects.toThrow('not recorded');

        const receiptPath = join(directory, 'assets/terminal-layout-state-isolation.json');
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
            launches: Array<Record<string, unknown>>;
        };
        expect(receipt.launches[0]).toMatchObject({
            cleanupCompleted: true,
            cleanupRequested: true,
            forcedCompletion: { reason: 'launcher force-killed', source: 'stop-electron' },
            ready: true,
        });
        expect(receipt.launches[0].completedAt).toEqual(expect.any(String));

        // A forced but verified-clean launch finalizes and can be retried with a fresh profile.
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        result.cases[0] = {
            category: '终端布局',
            evidence: ['assets/terminal.png', 'assets/terminal-layout-state-isolation.json'],
            id: 'terminal-layout',
            name: '终端内容填满工作区',
            observation: '启动器被强制结束后回执仍然完整。',
            status: 'pass',
            surface: 'desktop',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'assets/terminal.png'), 'image'),
        ]);
        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { passed: 1, verdict: 'pass' },
        });
    });

    it('records deferred cleanup on a completed receipt once the profile is verified gone', async () => {
        const directory = await reportDirectory();
        await initialize(directory);
        const launchId = await beginCaseLifecycle(directory, {
            caseId: 'terminal-layout',
            profileIdentity: 'deferred-profile',
            stateIsolation: { mode: 'isolated' },
        });
        await markCaseLifecycleReady(directory, { caseId: 'terminal-layout', launchId });
        // The launcher completed honestly while a detached Server generation still held the profile.
        await completeCaseLifecycle(directory, {
            caseId: 'terminal-layout',
            cleanupCompleted: false,
            cleanupRequested: true,
            launchId,
        });
        // An unverified profile never upgrades the record.
        await expect(
            forceCompleteCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                cleanupCompleted: false,
                cleanupRequested: true,
                launchId,
                reason: 'launcher exited',
                source: 'stop-electron',
            }),
        ).resolves.toBe('already_completed');
        await expect(
            forceCompleteCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                cleanupCompleted: true,
                cleanupRequested: true,
                launchId,
                reason: 'launcher exited',
                source: 'stop-electron',
            }),
        ).resolves.toBe('cleanup_recorded');
        const receipt = JSON.parse(
            await readFile(join(directory, 'assets/terminal-layout-state-isolation.json'), 'utf8'),
        ) as { launches: Array<Record<string, unknown>> };
        expect(receipt.launches[0]).toMatchObject({
            cleanupCompleted: true,
            deferredCleanup: { source: 'stop-electron' },
        });
        expect(receipt.launches[0].forcedCompletion).toBeUndefined();
        // Idempotent: a second stop finds nothing left to record.
        await expect(
            forceCompleteCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                cleanupCompleted: true,
                cleanupRequested: true,
                launchId,
                reason: 'launcher exited',
                source: 'stop-electron',
            }),
        ).resolves.toBe('already_completed');

        // Finalize now accepts the case: the profile is gone and the receipt says who verified it.
        const resultPath = join(directory, 'result.json');
        const result = parseReport(await readFile(resultPath, 'utf8'));
        result.cases[0] = {
            category: '终端布局',
            evidence: ['assets/terminal.png', 'assets/terminal-layout-state-isolation.json'],
            id: 'terminal-layout',
            name: '终端内容填满工作区',
            observation: '停止脚本在启动器之后完成了配置目录清理。',
            status: 'pass',
            surface: 'desktop',
        };
        await Promise.all([
            writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
            writeFile(join(directory, 'assets/terminal.png'), 'image'),
        ]);
        await expect(finalizeReport({ directory, requirement })).resolves.toMatchObject({
            summary: { passed: 1, verdict: 'pass' },
        });
    });

    it('repairs a stuck receipt with a reason only after the isolated profile is verified gone', async () => {
        const directory = await reportDirectory();
        await initialize(directory);
        const launchId = await beginCaseLifecycle(directory, {
            caseId: 'terminal-layout',
            profileIdentity: 'stuck-profile',
            stateIsolation: { mode: 'isolated' },
        });
        await markCaseLifecycleReady(directory, { caseId: 'terminal-layout', launchId });
        await expect(
            beginCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                profileIdentity: 'retry-profile',
                stateIsolation: { mode: 'isolated' },
            }),
        ).rejects.toThrow('has not completed');
        await expect(finalizeReport({ directory, requirement })).rejects.toThrow();

        await expect(
            repairCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                isProfileRemoved: () => Promise.resolve(false),
                reason: 'launcher exited 137',
            }),
        ).rejects.toThrow('still exists');
        await expect(
            repairCaseLifecycle(directory, {
                caseId: 'other-case',
                isProfileRemoved: () => Promise.resolve(true),
                reason: 'launcher exited 137',
            }),
        ).rejects.toThrow();
        await expect(
            repairCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                isProfileRemoved: () => Promise.resolve(true),
                reason: ' '.repeat(3),
            }),
        ).rejects.toThrow();

        await expect(
            repairCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                isProfileRemoved: (profileIdentity) =>
                    Promise.resolve(profileIdentity === 'stuck-profile'),
                reason: 'launcher exited 137',
            }),
        ).resolves.toMatchObject({ repairedLaunchIds: [launchId] });
        await expect(
            repairCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                isProfileRemoved: () => Promise.resolve(true),
                reason: 'again',
            }),
        ).rejects.toThrow('no pending launch');

        const receipt = JSON.parse(
            await readFile(join(directory, 'assets/terminal-layout-state-isolation.json'), 'utf8'),
        ) as { launches: Array<Record<string, unknown>> };
        expect(receipt.launches[0]).toMatchObject({
            cleanupCompleted: true,
            cleanupRequested: true,
            forcedCompletion: { reason: 'launcher exited 137', source: 'report-repair' },
        });

        // The repaired history no longer blocks a retry with a fresh profile.
        await expect(
            beginCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                profileIdentity: 'retry-profile',
                stateIsolation: { mode: 'isolated' },
            }),
        ).resolves.toEqual(expect.any(String));
    });

    it('repairs a stuck restart launch without claiming cleanup of the shared profile', async () => {
        const directory = await reportDirectory();
        const stateIsolation = {
            cleanupOwner: 'final_launch',
            mode: 'restart',
            profileId: 'shared-profile',
        } as const;
        await initialize(directory, { plan: [{ ...plan[0], stateIsolation }] });
        const launchId = await beginCaseLifecycle(directory, {
            caseId: 'terminal-layout',
            profileIdentity: 'shared-profile',
            stateIsolation,
        });

        await expect(
            repairCaseLifecycle(directory, {
                caseId: 'terminal-layout',
                isProfileRemoved: () =>
                    Promise.reject(new Error('restart repair must not probe the shared profile')),
                reason: 'launcher hung',
            }),
        ).resolves.toMatchObject({ repairedLaunchIds: [launchId] });
        const receipt = JSON.parse(
            await readFile(join(directory, 'assets/terminal-layout-state-isolation.json'), 'utf8'),
        ) as { launches: Array<Record<string, unknown>> };
        expect(receipt.launches[0]).toMatchObject({
            cleanupCompleted: false,
            cleanupRequested: false,
            forcedCompletion: { reason: 'launcher hung', source: 'report-repair' },
        });
    });
});
