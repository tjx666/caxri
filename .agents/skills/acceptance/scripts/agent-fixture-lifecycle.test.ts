import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
    beginAgentFixtureLifecycle,
    completeAgentFixtureLifecycle,
    recordDeferredAgentFixtureCleanup,
    validateAgentFixtureEvidence,
} from './agent-fixture-lifecycle';
import { initializeReport } from './report';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/**
 * The production path guard requires fixtures under the real project `.records/` root.
 */
const TEST_ROOT = join(
    PROJECT_ROOT,
    '.records',
    '__test__',
    `acceptance-agent-fixture-${process.pid}`,
);
const acceptanceRoots: string[] = [];

async function reportDirectory(
    fixtureId: 'agent-features-v1' | 'grok-build-v1' | 'agent-delegation-v1' = 'agent-features-v1',
): Promise<string> {
    await mkdir(TEST_ROOT, { recursive: true });
    const root = await mkdtemp(join(TEST_ROOT, 'case-'));
    acceptanceRoots.push(root);
    const directory = join(root, 'round-1');
    await initializeReport({
        directory,
        entry: '在 Caxri Electron 中打开首个 Session 终端。',
        plan: [
            {
                agentFixture: fixtureId,
                category: '终端布局',
                expected: '终端视口周围不出现应用背景色条。',
                id: 'terminal-layout',
                method: '启动隔离的 Caxri 并检查稳定后的终端布局。',
                requiredEvidence: ['screenshot'],
                surface: 'desktop',
                title: '终端内容填满工作区',
                verifier: 'agent',
            },
        ],
        requirement: 'Caxri 终端应完整填满工作区。',
        title: '验收 Caxri 终端布局',
    });
    return directory;
}

afterEach(async () => {
    const directories = [...acceptanceRoots];
    acceptanceRoots.length = 0;
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
});

afterAll(async () => {
    await rm(TEST_ROOT, { force: true, recursive: true });
});

describe('Acceptance Agent fixture lifecycle', () => {
    it('binds the Grok-only fixture to its declared provider and cleanup', async () => {
        const directory = await reportDirectory('grok-build-v1');
        const launchId = await beginAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            fixtureId: 'grok-build-v1',
        });
        await completeAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            launchId,
            cleanupCompleted: true,
            sharedProfile: false,
        });
        const evidence = 'assets/terminal-layout-agent-fixture.json';
        const receipt = JSON.parse(await readFile(join(directory, evidence), 'utf8')) as {
            providers: string[];
        };
        expect(receipt.providers).toEqual(['grok']);
        await expect(
            validateAgentFixtureEvidence(directory, {
                caseId: 'terminal-layout',
                fixtureId: 'grok-build-v1',
                evidencePaths: [evidence],
            }),
        ).resolves.toBeUndefined();
        await expect(
            validateAgentFixtureEvidence(directory, {
                caseId: 'terminal-layout',
                fixtureId: 'agent-features-v1',
                evidencePaths: [evidence],
            }),
        ).rejects.toThrow();
    });
    it('covers every earlier launch of a shared restart profile with one deferred cleanup', async () => {
        const directory = await reportDirectory();
        const first = await beginAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            fixtureId: 'agent-features-v1',
        });
        // An earlier restart launch keeps the shared profile, so it never records cleanup itself.
        await completeAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            cleanupCompleted: false,
            launchId: first,
            sharedProfile: true,
        });
        const last = await beginAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            fixtureId: 'agent-features-v1',
        });
        await completeAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            cleanupCompleted: false,
            launchId: last,
            sharedProfile: true,
        });
        await expect(
            recordDeferredAgentFixtureCleanup(directory, {
                caseId: 'terminal-layout',
                launchId: last,
                sharedProfile: true,
                source: 'stop-electron',
            }),
        ).resolves.toBe('cleanup_recorded');
        const evidence = 'assets/terminal-layout-agent-fixture.json';
        const receipt = JSON.parse(await readFile(join(directory, evidence), 'utf8')) as {
            launches: Array<{ cleanupCompleted: boolean }>;
        };
        expect(receipt.launches.map(({ cleanupCompleted }) => cleanupCompleted)).toEqual([
            true,
            true,
        ]);
        await expect(
            validateAgentFixtureEvidence(directory, {
                caseId: 'terminal-layout',
                evidencePaths: [evidence],
                fixtureId: 'agent-features-v1',
            }),
        ).resolves.toBeUndefined();
    });

    it('records deferred fixture cleanup only on a completed launch whose profile was removed later', async () => {
        const directory = await reportDirectory();
        const launchId = await beginAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            fixtureId: 'agent-features-v1',
        });
        const input = {
            caseId: 'terminal-layout',
            launchId,
            sharedProfile: false,
            source: 'stop-electron' as const,
        };
        // A pending launch belongs to the launcher; the stop adapter never closes it through this path.
        await expect(recordDeferredAgentFixtureCleanup(directory, input)).resolves.toBe('pending');
        // The launcher completed honestly while a detached Server generation still held the profile.
        await completeAgentFixtureLifecycle(directory, {
            caseId: 'terminal-layout',
            cleanupCompleted: false,
            launchId,
            sharedProfile: false,
        });
        await expect(recordDeferredAgentFixtureCleanup(directory, input)).resolves.toBe(
            'cleanup_recorded',
        );
        await expect(recordDeferredAgentFixtureCleanup(directory, input)).resolves.toBe(
            'already_completed',
        );
        await expect(
            recordDeferredAgentFixtureCleanup(directory, { ...input, launchId: 'unknown' }),
        ).rejects.toThrow('not recorded');
        const evidence = 'assets/terminal-layout-agent-fixture.json';
        const receipt = JSON.parse(await readFile(join(directory, evidence), 'utf8')) as {
            launches: Array<Record<string, unknown>>;
        };
        expect(receipt.launches[0]).toMatchObject({
            cleanupCompleted: true,
            deferredCleanup: { source: 'stop-electron' },
        });
        await expect(
            validateAgentFixtureEvidence(directory, {
                caseId: 'terminal-layout',
                evidencePaths: [evidence],
                fixtureId: 'agent-features-v1',
            }),
        ).resolves.toBeUndefined();
    });
});
