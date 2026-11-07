import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    getAgentFixtureStdout,
    observeAgentFixtureProcess,
    stopAgentFixtureProcess,
    waitForAgentFixtureReady,
} from '../agent-fixture-process';
import { prepareAcceptanceAgentFixture } from '../agent-fixtures';
import { fixtureExecutable, readReceipts, waitForReceiptCount } from './agent-fixture-test-support';

const directories: string[] = [];

afterEach(async () => {
    const currentDirectories = [...directories];
    directories.length = 0;
    await Promise.all(
        currentDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe('Acceptance Agent fixture initial turn', () => {
    it('completes the initial Claude turn with its provider hooks and no SessionStart binding', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        const claudeRoot = fixture.environment.CLAUDE_CONFIG_DIR!;
        const hook = [{ hooks: [{ command: '/usr/bin/true' }] }];
        await writeFile(
            join(claudeRoot, 'settings.json'),
            JSON.stringify({
                hooks: { UserPromptSubmit: hook, Stop: hook },
            }),
        );
        const fixtureProcess = observeAgentFixtureProcess(
            spawn(fixtureExecutable(fixture, 'claude'), [], {
                env: fixture.environment,
                stdio: ['pipe', 'pipe', 'pipe'],
            }),
        );
        try {
            await waitForAgentFixtureReady(fixtureProcess, 'Fake claude Acceptance fixture ready');
            await waitForReceiptCount(claudeRoot, 'Stop', 1);
            const receipts = await readReceipts(claudeRoot);
            expect(receipts.filter(({ event }) => event === 'UserPromptSubmit')).toHaveLength(1);
            expect(receipts.filter(({ event }) => event === 'SessionStart')).toHaveLength(0);
        } finally {
            await stopAgentFixtureProcess(fixtureProcess);
        }
    });

    it('publishes a per-launch public-frame ready receipt only after the initial turn stopped', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            isPublicFrame: true,
            userDataDir: userDataDirectory,
        });
        const claudeRoot = fixture.environment.CLAUDE_CONFIG_DIR!;
        const launch = () =>
            observeAgentFixtureProcess(
                spawn(fixtureExecutable(fixture, 'claude'), [], {
                    env: fixture.environment,
                    stdio: ['pipe', 'pipe', 'pipe'],
                }),
            );
        const launches = [launch(), launch()];
        try {
            // Without managed hooks the initial turn cannot stop, so a listening Agent is not ready yet.
            await new Promise((resolve) => setTimeout(resolve, 400));
            expect(await readReceipts(claudeRoot)).not.toContainEqual(
                expect.objectContaining({ kind: 'fixtureReady' }),
            );

            const hook = [{ hooks: [{ command: '/usr/bin/true' }] }];
            await writeFile(
                join(claudeRoot, 'settings.json'),
                JSON.stringify({ hooks: { UserPromptSubmit: hook, Stop: hook } }),
            );
            await expect
                .poll(
                    async () =>
                        (await readReceipts(claudeRoot)).filter(
                            ({ kind }) => kind === 'fixtureReady',
                        ).length,
                    { timeout: 5_000 },
                )
                .toBe(2);
            const receipts = await readReceipts(claudeRoot);
            const ready = receipts.filter(({ kind }) => kind === 'fixtureReady');
            // Each ready receipt follows at least as many initial-turn Stops as launches that are ready by then.
            for (const [ordinal, receipt] of ready.entries()) {
                const stopsBefore = receipts
                    .slice(0, receipts.indexOf(receipt))
                    .filter(({ event }) => event === 'Stop').length;
                expect(stopsBefore).toBeGreaterThanOrEqual(ordinal + 1);
            }
            expect(new Set(ready.map(({ agentSessionId }) => agentSessionId))).toEqual(
                new Set(launches.map(({ child }) => `claude-acceptance-${child.pid}`)),
            );
            for (const fixtureProcess of launches)
                expect(getAgentFixtureStdout(fixtureProcess)).toBe('');
        } finally {
            await Promise.all(
                launches.map((fixtureProcess) => stopAgentFixtureProcess(fixtureProcess)),
            );
        }
    });

    it('waits for managed hooks before starting the initial fixture turn', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        const codexRoot = fixture.environment.CODEX_HOME!;
        const fixtureProcess = observeAgentFixtureProcess(
            spawn(fixtureExecutable(fixture, 'codex'), [], {
                env: fixture.environment,
                stdio: ['pipe', 'pipe', 'pipe'],
            }),
        );
        try {
            await waitForAgentFixtureReady(fixtureProcess, 'Fake codex Acceptance fixture ready');
            await new Promise((resolve) => setTimeout(resolve, 700));
            expect(await readReceipts(codexRoot)).not.toContainEqual(
                expect.objectContaining({ kind: 'fixtureError' }),
            );

            const hook = { hooks: [{ command: '/usr/bin/true' }] };
            await writeFile(
                join(codexRoot, 'hooks.json'),
                JSON.stringify({
                    hooks: { SessionStart: [hook], Stop: [hook], UserPromptSubmit: [hook] },
                }),
            );
            await expect
                .poll(
                    async () =>
                        (await readReceipts(codexRoot)).filter(({ kind }) => kind === 'hook')
                            .length,
                )
                .toBe(3);
            expect(await readReceipts(codexRoot)).not.toContainEqual(
                expect.objectContaining({ kind: 'fixtureError' }),
            );
        } finally {
            await stopAgentFixtureProcess(fixtureProcess);
        }
    });
});
