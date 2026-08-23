import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';

import {
    createPiSpikeExecutableSource,
    createPiSpikeExtensionSource,
    createPiSpikeLaunch,
    createPiSpikeSessionId,
    startPiSpikeModelServer,
    verifyPiSpikeExecutable,
} from '../scripts/pi-pty-feasibility-support.ts';
import { execFileAsync } from '../src/shared/node/exec.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxriApp,
    pageRequest,
    stopE2EHost,
    typeTerminal,
    waitForRuntimeReady,
} from './support/helpers.ts';

interface PiBootstrap {
    terminals: Array<{ agentSessionId?: string; id: string; processId?: number }>;
}

interface OwnedPty {
    exit: Promise<void>;
    exited: boolean;
    terminal: IPty;
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
    const controller = new AbortController();
    try {
        return await Promise.race([
            promise,
            (async () => {
                await delay(timeoutMs, undefined, { signal: controller.signal });
                throw new Error(message);
            })(),
        ]);
    } finally {
        controller.abort();
    }
}

async function seedPiSession(
    launch: ReturnType<typeof createPiSpikeLaunch>,
    ownedPtys: Set<OwnedPty>,
): Promise<void> {
    const terminal = spawn(
        launch.executable,
        [...launch.args, 'Return the deterministic response marker.'],
        {
            cols: 100,
            cwd: launch.cwd,
            env: launch.env,
            name: 'xterm-256color',
            rows: 30,
        },
    );
    const tracked: OwnedPty = {
        exit: Promise.resolve(),
        exited: false,
        terminal,
    };
    tracked.exit = new Promise<void>((resolve, reject) => {
        let hasMarker = false;
        let output = '';
        terminal.onData((data) => {
            output = `${output}${data}`.slice(-256 * 1024);
            if (hasMarker || !output.includes('CAXRI_PI_MODEL_OK')) return;
            hasMarker = true;
            terminal.write('/caxri-exit\r');
        });
        terminal.onExit(({ exitCode, signal }) => {
            tracked.exited = true;
            ownedPtys.delete(tracked);
            if (!hasMarker || exitCode !== 0 || (signal ?? 0) !== 0) {
                reject(new Error('Official Pi session seed did not exit normally'));
                return;
            }
            resolve();
        });
    });
    ownedPtys.add(tracked);
    try {
        await waitWithTimeout(
            tracked.exit,
            20_000,
            'Official Pi did not seed the bounded lifecycle marker',
        );
    } catch (error) {
        if (!tracked.exited) terminal.kill('SIGKILL');
        try {
            await waitWithTimeout(tracked.exit, 2_000, 'Official Pi seed cleanup timed out');
        } catch (cleanupError) {
            throw new AggregateError([error], 'Official Pi seed cleanup failed', {
                cause: cleanupError,
            });
        }
        throw error;
    }
}

async function readInvocationReceipts(path: string): Promise<string[]> {
    try {
        return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

async function countLifecycleEvents(path: string, kind: string): Promise<number> {
    try {
        return (await readFile(path, 'utf8'))
            .split('\n')
            .filter((line) => line.startsWith(`${kind}\t`)).length;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
    }
}

test('official Pi keeps one caller-owned session across Caxri Restart and app relaunch', async () => {
    const requestedPiBin = process.env.CAXRI_PI_SPIKE_BIN;
    test.skip(!requestedPiBin, 'Set CAXRI_PI_SPIKE_BIN to the isolated official Pi binary');
    if (!requestedPiBin) return;

    const piBin = (await verifyPiSpikeExecutable(resolve(requestedPiBin))).path;
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-pi-pty-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const piRoot = join(testDirectory, 'pi');
    const eventsPath = join(piRoot, 'lifecycle.events');
    const extensionPath = join(piRoot, 'extension.ts');
    const invocationReceiptPath = join(piRoot, 'invocations.events');
    const codexState = join(userData, 'e2e-agents', 'codex');
    const codexDatabase = join(codexState, 'state_9.sqlite');
    const sessionId = createPiSpikeSessionId(randomUUID());
    const server = await startPiSpikeModelServer({ responseDelayMs: 2_000 });
    const ownedPtys = new Set<OwnedPty>();
    let first: Awaited<ReturnType<typeof launchCaxriApp>> | undefined;
    let second: Awaited<ReturnType<typeof launchCaxriApp>> | undefined;
    let cleanupFailure: unknown;
    try {
        await Promise.all(
            [
                root,
                userData,
                ...['config', 'home', 'project', 'sessions', 'tmp'].map((name) =>
                    join(piRoot, name),
                ),
            ].map((path) => mkdir(path, { recursive: true })),
        );
        await writeFile(extensionPath, createPiSpikeExtensionSource(), {
            encoding: 'utf8',
            mode: 0o600,
        });
        const launch = createPiSpikeLaunch({
            endpoint: server.endpoint,
            eventsPath,
            extensionPath,
            piBin,
            root: piRoot,
            sessionId,
        });

        /**
         * Seed one official Pi session through a PTY and structured argv. The focused desktop phase starts from that
         * durable identity so it can isolate Caxri's Restart and Desktop reconnection behavior.
         */
        await seedPiSession(launch, ownedPtys);

        const agentMode = await createFakeAgentMode({
            userDataDir: userData,
            providers: {
                codex: {
                    executableSource: createPiSpikeExecutableSource(launch, {
                        invocationReceiptPath,
                    }),
                },
            },
        });
        const fakeExecutable = agentMode.executables.codex;
        if (!fakeExecutable) throw new Error('Pi spike fake executable was not created');
        const canonicalRoot = await realpath(root);
        await execFileAsync('sqlite3', [
            codexDatabase,
            `CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                cwd TEXT,
                title TEXT,
                created_at_ms INTEGER,
                updated_at_ms INTEGER,
                tokens_used INTEGER,
                archived INTEGER
            );`,
        ]);
        first = await launchCaxriApp({
            agentMode,
            preserveHostOnClose: true,
            testRootPath: root,
            userDataDir: userData,
        });
        await waitForRuntimeReady(first.page);
        await createProjectSession(first.page, 'codex');
        await expect(first.page.locator('.xterm-rows')).toContainText('CAXRI_PI_MODEL_OK');
        const metadataTimestamp = Date.now();
        await execFileAsync('sqlite3', [
            codexDatabase,
            `INSERT INTO threads VALUES (
                '${sessionId}',
                '${canonicalRoot}',
                'Pi feasibility',
                ${metadataTimestamp},
                ${metadataTimestamp},
                0,
                0
            );`,
        ]);
        await expect
            .poll(async () => {
                const bootstrap = await pageRequest<PiBootstrap>(first!.page, 'app.bootstrap');
                return bootstrap.terminals[0]?.agentSessionId;
            })
            .toBe(sessionId);
        const before = await pageRequest<PiBootstrap>(first.page, 'app.bootstrap');
        const terminal = before.terminals[0];
        if (!terminal.processId) throw new Error('Official Pi PTY process was not running');
        const hostBefore = await pageRequest<{ pid: number; runtimePid?: number }>(
            first.page,
            'host.status',
        );

        await first.app.close();
        second = await launchCaxriApp({
            agentMode,
            testRootPath: root,
            userDataDir: userData,
        });
        await waitForRuntimeReady(second.page);
        await expect(second.page.locator('.xterm-rows')).toContainText('CAXRI_PI_MODEL_OK');
        const afterRelaunch = await pageRequest<PiBootstrap>(second.page, 'app.bootstrap');
        const hostAfter = await pageRequest<{ pid: number; runtimePid?: number }>(
            second.page,
            'host.status',
        );
        expect(afterRelaunch.terminals).toEqual(before.terminals);
        expect(afterRelaunch.terminals[0]?.agentSessionId).toBe(sessionId);
        expect(hostAfter.pid).toBe(hostBefore.pid);
        expect(hostAfter.runtimePid).toBe(hostBefore.runtimePid);
        await expect
            .poll(() => readInvocationReceipts(invocationReceiptPath))
            .toEqual([`create\t${sessionId}`]);

        await typeTerminal(second.page, '/caxri-exit');
        const stopped = second.page.locator('[data-terminal-exit-state="stopped"]');
        await expect(stopped).toContainText('Process exited normally');
        const startsBeforeFirstResume = await countLifecycleEvents(eventsPath, 'session_start');
        await stopped.getByRole('button', { name: 'Resume Agent Session' }).click();
        await expect(stopped).toHaveCount(0);
        await expect
            .poll(() => countLifecycleEvents(eventsPath, 'session_start'))
            .toBeGreaterThan(startsBeforeFirstResume);
        await expect(
            second.page.locator('.terminal-surface[data-terminal-attached="true"]'),
        ).toBeVisible();
        await expect
            .poll(() => readInvocationReceipts(invocationReceiptPath))
            .toEqual([`create\t${sessionId}`, `resume\t${sessionId}`]);
        const afterRestart = await pageRequest<PiBootstrap>(second.page, 'app.bootstrap');
        expect(afterRestart.terminals[0]?.id).toBe(terminal.id);
        expect(afterRestart.terminals[0]?.agentSessionId).toBe(sessionId);
        expect(afterRestart.terminals[0]?.processId).not.toBe(terminal.processId);

        const interruptionPid = afterRestart.terminals[0]?.processId;
        if (!interruptionPid) throw new Error('Resumed Pi PTY process was not running');
        const requestsBeforeInterruption = server.requestCount();
        await typeTerminal(second.page, 'Interrupt this deterministic request');
        await expect.poll(() => server.requestCount()).toBeGreaterThan(requestsBeforeInterruption);
        process.kill(interruptionPid, 'SIGTERM');
        await expect(stopped).toContainText('Process exited normally');
        const startsBeforeInterruptedResume = await countLifecycleEvents(
            eventsPath,
            'session_start',
        );
        await stopped.getByRole('button', { name: 'Resume Agent Session' }).click();
        await expect(stopped).toHaveCount(0);
        await expect
            .poll(() => countLifecycleEvents(eventsPath, 'session_start'))
            .toBeGreaterThan(startsBeforeInterruptedResume);
        await expect
            .poll(() => readInvocationReceipts(invocationReceiptPath))
            .toEqual([`create\t${sessionId}`, `resume\t${sessionId}`, `resume\t${sessionId}`]);

        const beforeAbnormal = await pageRequest<PiBootstrap>(second.page, 'app.bootstrap');
        const abnormalPid = beforeAbnormal.terminals[0]?.processId;
        if (!abnormalPid) throw new Error('Interrupted Pi PTY did not resume');
        process.kill(abnormalPid, 'SIGKILL');
        const dead = second.page.locator('[data-terminal-exit-state="dead"]');
        await expect(dead).toContainText('Terminal stopped unexpectedly');
        await expect(dead).toHaveClass(/terminal-recovery-danger/);
        const startsBeforeAbnormalResume = await countLifecycleEvents(eventsPath, 'session_start');
        await dead.getByRole('button', { name: 'Resume Agent Session' }).click();
        await expect(dead).toHaveCount(0);
        await expect
            .poll(() => countLifecycleEvents(eventsPath, 'session_start'))
            .toBeGreaterThan(startsBeforeAbnormalResume);
        await expect
            .poll(() => readInvocationReceipts(invocationReceiptPath))
            .toEqual([
                `create\t${sessionId}`,
                `resume\t${sessionId}`,
                `resume\t${sessionId}`,
                `resume\t${sessionId}`,
            ]);

        await typeTerminal(second.page, '/caxri-exit');
        await expect(stopped).toContainText('Process exited normally');
    } finally {
        for (const ownedPty of ownedPtys) {
            try {
                if (!ownedPty.exited) ownedPty.terminal.kill('SIGKILL');
            } catch (error) {
                cleanupFailure ??= error;
            }
        }
        const ownedPtyResults = await Promise.allSettled(
            [...ownedPtys].map((ownedPty) => ownedPty.exit),
        );
        cleanupFailure ??= ownedPtyResults.find((result) => result.status === 'rejected')?.reason;
        try {
            await first?.app.close();
        } catch (error) {
            cleanupFailure ??= error;
        }
        try {
            await second?.app.close();
        } catch (error) {
            cleanupFailure ??= error;
        }
        try {
            await stopE2EHost(userData);
        } catch (error) {
            cleanupFailure ??= error;
        }
        try {
            await server.close();
        } catch (error) {
            cleanupFailure ??= error;
        }
        try {
            await rm(testDirectory, { recursive: true, force: true });
        } catch (error) {
            cleanupFailure ??= error;
        }
    }
    if (cleanupFailure) {
        throw cleanupFailure instanceof Error
            ? cleanupFailure
            : new Error('Pi feasibility E2E cleanup failed', { cause: cleanupFailure });
    }
});

test('missing Pi CLI uses Caxri provider-neutral recovery without fake metadata', async () => {
    allowE2EErrors([
        { source: 'runtime', event: 'pty.spawn_failed', code: 'UNAVAILABLE', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-pi-missing-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    let running: Awaited<ReturnType<typeof launchCaxriApp>> | undefined;
    let cleanupFailure: unknown;
    try {
        await mkdir(root, { recursive: true });
        running = await launchCaxriApp({
            agentMode: { mode: 'blocked' },
            env: { PATH: join(testDirectory, 'missing-bin'), SHELL: '/usr/bin/false' },
            testRootPath: root,
            userDataDir: userData,
        });
        await waitForRuntimeReady(running.page);
        await createProjectSession(running.page, 'codex');
        const failed = running.page.locator('[data-terminal-exit-state="failed"]');
        await expect(failed).toContainText('Agent CLI executable was not found');
        await expect(failed).toHaveClass(/terminal-recovery-danger/);
        await expect(failed.getByRole('button', { name: 'Restart Terminal' })).toBeVisible();
        const bootstrap = await pageRequest<PiBootstrap>(running.page, 'app.bootstrap');
        expect(bootstrap.terminals[0]?.agentSessionId).toBeUndefined();
    } finally {
        try {
            await running?.app.close();
        } catch (error) {
            cleanupFailure ??= error;
        }
        try {
            await stopE2EHost(userData);
        } catch (error) {
            cleanupFailure ??= error;
        }
        try {
            await rm(testDirectory, { recursive: true, force: true });
        } catch (error) {
            cleanupFailure ??= error;
        }
    }
    if (cleanupFailure) {
        throw cleanupFailure instanceof Error
            ? cleanupFailure
            : new Error('Missing Pi E2E cleanup failed', { cause: cleanupFailure });
    }
});
