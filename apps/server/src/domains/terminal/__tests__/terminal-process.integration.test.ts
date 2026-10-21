import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

import type { ServerEvent } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import * as pty from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { createTestAgentService } from '../../__tests__/create-test-domain-services';
import { AgentCoordinator } from '../../agents/coordinator';
import { detectForegroundAgentProvider } from '../../agents/process-detection';
import { CaxriDatabase } from '../../db/repository';
import { ShellIntegrationService } from '../shell-integration';

const temporaryDirectories: string[] = [];
const temporaryLoggers: StructuredLogger[] = [];
const spawnedPtys: TrackedPty[] = [];

interface TrackedPty {
    exit: Promise<void>;
    exited: boolean;
    process: pty.IPty;
}

/**
 * Vitest forks must not exit while node-pty still owns a child or a pending native callback. Tracking the native exit
 * separately from TerminalManager state makes teardown deterministic even for close and shutdown paths that retire the
 * durable Terminal before the OS child reports its exit.
 */
function spawnTrackedPty(
    file: string,
    arguments_: string[] | string,
    options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions,
): pty.IPty {
    const process = pty.spawn(file, arguments_, options);
    const tracked: TrackedPty = {
        exit: Promise.resolve(),
        exited: false,
        process,
    };
    tracked.exit = new Promise((resolve) => {
        const subscription = process.onExit(() => {
            tracked.exited = true;
            subscription.dispose();
            resolve();
        });
    });
    spawnedPtys.push(tracked);
    return process;
}

function createTestLogger(logDirectory: string): StructuredLogger {
    const logger = new StructuredLogger(logDirectory);
    temporaryLoggers.push(logger);
    return logger;
}

/**
 * PTY spawn/attach does not prove an interactive shell has finished startup. Use a profile-free fixture and wait for
 * its generation-specific prompt, so host startup scripts cannot consume test input and restart cannot reuse old
 * proof.
 */
function createShellFixture(directory: string) {
    let generation = 0;
    const prompt = () => `CAXRI_TEST_SHELL_READY_${generation}> `;
    return {
        options: {
            resolveExecutable: () => Promise.resolve('/bin/bash'),
            shellIntegration: (_executable: string, environment: NodeJS.ProcessEnv) => {
                generation += 1;
                return {
                    args: ['--noprofile', '--norc', '-i'],
                    environment: {
                        ...environment,
                        HOME: directory,
                        PS1: prompt(),
                        PROMPT_COMMAND: '',
                        ENV: '',
                        BASH_ENV: '',
                    },
                };
            },
        },
        ready: async (
            manager: ReturnType<typeof createTestTerminalManager>,
            terminalId: string,
        ) => {
            await expect
                .poll(async () => (await manager.snapshot(terminalId))?.payload)
                .toContain(prompt());
        },
    };
}

async function drainTrackedPtys(): Promise<void> {
    const pendingPtys = [...spawnedPtys];
    spawnedPtys.length = 0;
    for (const tracked of pendingPtys) {
        if (tracked.exited) continue;
        try {
            tracked.process.kill();
        } catch {
            // The child can exit between the state check and kill; its tracked exit remains the source of truth.
        }
    }
    await Promise.all(pendingPtys.map(({ exit }) => exit));
    /**
     * Allow every listener scheduled by the native exit callback to finish before test-owned state is closed.
     */
    await waitForImmediate();
}

afterEach(async () => {
    await drainTrackedPtys();
    const pendingLoggers = [...temporaryLoggers];
    temporaryLoggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('TerminalManager process integration', () => {
    it.each([
        { shell: '/bin/zsh', interruptStartup: false },
        { shell: '/bin/zsh', interruptStartup: true },
        { shell: '/bin/bash', interruptStartup: false },
    ])(
        'loads user aliases after Agent exit in $shell (startup interrupt: $interruptStartup)',
        async ({ shell, interruptStartup }) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-shell-startup-'));
            temporaryDirectories.push(directory);
            const launcher = join(directory, 'launcher.cjs');
            /**
             * Deliver the exit interrupt to the waiting startup shell as well as the fixture. Raw-mode CLIs can handle
             * Ctrl+C themselves, so a plain exit code alone does not reproduce zsh's interrupted-startup state.
             */
            await writeFile(
                launcher,
                String.raw`
process.stdin.resume();
process.on('SIGINT', () => {
    process.kill(process.ppid, 'SIGINT');
    process.exit(130);
});
process.stdout.write('FIXTURE_AGENT_READY\r\n');
`,
            );
            await writeFile(
                join(directory, '.zshrc'),
                `${interruptStartup ? 'kill -INT $$\n' : ''}alias cxy='echo FIXTURE_ALIAS_READY'\n`,
            );
            await writeFile(join(directory, '.zlogin'), 'echo FIXTURE_LOGIN_READY\n');
            await writeFile(
                join(directory, '.bash_profile'),
                "alias cxy='echo FIXTURE_ALIAS_READY'\necho FIXTURE_LOGIN_READY\n",
            );
            const integration = await ShellIntegrationService.create(directory);
            const launch = integration.resolve(shell, { HOME: directory, PATH: '/usr/bin:/bin' });
            if (!launch) throw new Error('Missing shell integration');
            const child = spawnTrackedPty(shell, launch.args, {
                cwd: directory,
                env: {
                    ...launch.environment,
                    CAXRI_AGENT_LAUNCHER_RUNTIME: process.execPath,
                    CAXRI_AGENT_LAUNCHER_ENTRY: launcher,
                    CAXRI_AGENT_LAUNCHER_SOCKET: join(directory, 'fixture.sock'),
                    CAXRI_AGENT_LAUNCHER_ID: 'fixture-launch',
                    CAXRI_AGENT_LAUNCHER_TOKEN: 'fixture-token',
                },
            });
            let output = '';
            const visibleOutput = () => stripVTControlCharacters(output);
            child.onData((data) => {
                output += data;
            });
            await expect.poll(() => output).toContain('FIXTURE_AGENT_READY');
            child.write('\u{3}');
            await expect.poll(() => output).toContain('FIXTURE_LOGIN_READY');
            child.write('cxy\r');
            await expect.poll(visibleOutput).toContain('\r\nFIXTURE_ALIAS_READY\r\n');
            if (shell === '/bin/zsh') {
                child.write(
                    '[[ ! -o localtraps && ! -o localoptions ]] && test -z "$(trap)" && echo FIXTURE_TRAPS_RESTORED\r',
                );
                await expect.poll(visibleOutput).toContain('\r\nFIXTURE_TRAPS_RESTORED\r\n');
                child.write('test "$ZDOTDIR" = "$HOME" && echo FIXTURE_ZDOTDIR_RESTORED\r');
                await expect.poll(visibleOutput).toContain('\r\nFIXTURE_ZDOTDIR_RESTORED\r\n');
            }
            child.write('echo FIXTURE_READ_READY; read fixture; echo FIXTURE_READ_COMPLETED\r');
            await expect.poll(visibleOutput).toContain('\r\nFIXTURE_READ_READY\r\n');
            output = '';
            child.write('\u{3}');
            await expect.poll(() => output).toContain('\u{1B}]133;A\u{7}');
            child.write('cxy\r');
            await expect.poll(visibleOutput).toContain('\r\nFIXTURE_ALIAS_READY\r\n');
            expect(visibleOutput()).not.toContain('\r\nFIXTURE_READ_COMPLETED\r\n');
        },
    );

    it('spawns a real PTY, accepts input, emits output, persists a snapshot, and exits', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const events: ServerEvent[] = [];
        let output = '';
        let resolveExit: (() => void) | undefined;
        const exited = new Promise<void>((resolve) => (resolveExit = resolve));
        const shell = createShellFixture(directory);
        const manager = createTestTerminalManager(
            database,
            (event) => {
                events.push(event);
                if (event.event === 'terminal.output') output += event.payload.data;
                else if (event.event === 'terminal.exit') resolveExit?.();
            },
            createTestLogger(join(directory, 'logs')),
            { ...shell.options, spawn: spawnTrackedPty },
        );
        await Promise.all([manager.start(created.terminal!), manager.start(created.terminal!)]);
        await manager.attach(created.terminal!.id);
        await shell.ready(manager, created.terminal!.id);
        manager.write(created.terminal!.id, "printf 'CAXRI_%s_OK\\n' INTEGRATION\r");
        await expect.poll(() => output, { timeout: 5_000 }).toContain('CAXRI_INTEGRATION_OK');
        manager.resize(created.terminal!.id, 120, 40);
        manager.write(created.terminal!.id, 'exit\r');
        await exited;
        expect(events.some((event) => event.event === 'terminal.output')).toBe(true);
        expect(database.getSnapshot(created.terminal!.id)?.payload).toContain(
            'CAXRI_INTEGRATION_OK',
        );
        // The logger now drains writes asynchronously, so poll the log file instead of reading
        // it once: the `pty.spawned`/`pty.first_input` records may not be flushed to disk yet.
        await vi.waitFor(async () => {
            const records = (await readFile(join(directory, 'logs', 'server-core.jsonl'), 'utf8'))
                .trim()
                .split('\n')
                .map(
                    (line) =>
                        JSON.parse(line) as {
                            event: string;
                            durationMs?: number;
                            fields?: { inputBytes?: number };
                        },
                );
            expect(records.filter((record) => record.event === 'pty.spawned')).toHaveLength(1);
            expect(records.find((record) => record.event === 'pty.spawned')?.durationMs).toBeTypeOf(
                'number',
            );
            expect(
                records.find((record) => record.event === 'pty.first_input')?.fields?.inputBytes,
            ).toBeGreaterThan(0);
        });
        await drainTrackedPtys();
        database.close();
    });

    it('buffers detached output in the snapshot and emits only after attachment', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-detached-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        let output = '';
        const onOutputActivity = vi.fn();
        const shell = createShellFixture(directory);
        const manager = createTestTerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            createTestLogger(join(directory, 'logs')),
            { ...shell.options, onOutputActivity, spawn: spawnTrackedPty },
        );

        await manager.start(created.terminal!);
        await shell.ready(manager, created.terminal!.id);
        manager.write(created.terminal!.id, "printf 'DETACHED_%s\\n' ONLY\r");
        await expect
            .poll(async () => (await manager.snapshot(created.terminal!.id))?.payload)
            .toContain('DETACHED_ONLY');
        expect(onOutputActivity).toHaveBeenCalledWith(created.terminal!.id, expect.any(Number));
        expect(output).not.toContain('DETACHED_ONLY');
        expect((await manager.attach(created.terminal!.id))?.payload).toContain('DETACHED_ONLY');

        manager.write(created.terminal!.id, "printf 'ATTACHED_%s\\n' OUTPUT\r");
        await expect.poll(() => output).toContain('ATTACHED_OUTPUT');
        manager.detachView(created.terminal!.id);
        manager.write(created.terminal!.id, "printf 'DETACHED_%s\\n' AGAIN\r");
        await expect
            .poll(async () => (await manager.snapshot(created.terminal!.id))?.payload)
            .toContain('DETACHED_AGAIN');
        expect(output).not.toContain('DETACHED_AGAIN');

        await manager.shutdown('orderly');
        await drainTrackedPtys();
        database.close();
    });

    it('restarts a live PTY under the same durable terminal and closes it without late database writes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-restart-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        let output = '';
        const shell = createShellFixture(directory);
        const manager = createTestTerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            createTestLogger(join(directory, 'logs')),
            { ...shell.options, spawn: spawnTrackedPty },
        );

        await manager.start(created.terminal!);
        await manager.attach(created.terminal!.id);
        await manager.restart(created.terminal!.id);
        await shell.ready(manager, created.terminal!.id);
        manager.write(created.terminal!.id, "printf 'CAXRI_%s_OK\\n' RESTART\r");
        await expect.poll(() => output).toContain('CAXRI_RESTART_OK');
        expect(database.getTerminal(created.terminal!.id)?.lastProcessState).toBe('running');

        manager.close(created.terminal!.id);
        expect(database.getTerminal(created.terminal!.id)).toBeUndefined();
        await drainTrackedPtys();
        database.close();
    });

    /**
     * The explicit timeout covers the worst case of each bounded wait below: CLI startup, the independent foreground
     * barrier, and the longest production backoff between product probes.
     */
    it('reactivates a same-provider Agent launched manually in the live Shell', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-agent-relaunch-'));
        temporaryDirectories.push(directory);
        const executable = join(directory, 'claude');
        await writeFile(
            executable,
            `#!${process.execPath}\nprocess.stdin.setRawMode?.(true);\nprocess.stdin.resume();\nprocess.stdout.write('MANUAL_CLAUDE_READY\\r\\n');\n`,
        );
        await chmod(executable, 0o700);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const logger = createTestLogger(join(directory, 'logs'));
        const detectedProviders: Array<'claude' | 'codex' | 'grok' | undefined> = [];
        const coordinator = new AgentCoordinator(
            database,
            createTestAgentService({
                claude: {
                    provider: 'claude',
                    snapshot: () =>
                        Promise.resolve({
                            provider: 'claude',
                            status: 'running',
                            observedAt: Date.now(),
                            available: true,
                        }),
                },
            }),
            () => {},
            logger,
            {
                detectForegroundAgent: async (shellPid) => {
                    const provider = await detectForegroundAgentProvider(shellPid);
                    detectedProviders.push(provider);
                    return provider;
                },
                refreshDelayMs: 5,
            },
        );
        let output = '';
        let observedShellPid: number | undefined;
        const shell = createShellFixture(directory);
        const manager = createTestTerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            logger,
            {
                ...shell.options,
                onOutputActivity: (terminalId, shellPid) => {
                    observedShellPid = shellPid;
                    coordinator.observeOutput(terminalId, shellPid);
                },
                spawn: spawnTrackedPty,
            },
        );

        try {
            await manager.start(created.terminal!);
            await manager.attach(created.terminal!.id);
            await shell.ready(manager, created.terminal!.id);
            expect(database.promoteShellToAgent(created.terminal!.id, 'claude')).toBe(true);
            database.updateAgentProcessState(created.terminal!.id, 'stopped');

            expect(manager.write(created.terminal!.id, `${executable}\r`)).toBe(true);
            expect(coordinator.observeInput(created.terminal!.id, `${executable}\r`)).toBe(true);

            await expect.poll(() => output, { timeout: 5_000 }).toContain('MANUAL_CLAUDE_READY');
            /**
             * Barrier: an independent process-table read must see the synthetic CLI in the PTY foreground group before
             * the product is judged. A timeout here means the host had not exposed the process yet (the test waited too
             * little); a timeout on the next wait means the coordinator missed an Agent the OS already showed. That
             * product wait gets ten seconds because the longest production backoff between probes is eight.
             */
            await expect
                .poll(
                    () =>
                        observedShellPid === undefined
                            ? undefined
                            : detectForegroundAgentProvider(observedShellPid),
                    { timeout: 10_000 },
                )
                .toBe('claude');
            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.lastAgentProcessState, {
                    timeout: 10_000,
                })
                .toBe('running');
            expect(detectedProviders).toContain('claude');
        } finally {
            await coordinator.close();
            await manager.shutdown('orderly');
            await drainTrackedPtys();
            database.close();
        }
    }, 30_000);

    it('ignores input and resize requests that arrive after a Terminal has stopped', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-stale-input-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const shell = createShellFixture(directory);
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            { ...shell.options, spawn: spawnTrackedPty },
        );

        expect(manager.write(created.terminal!.id, 'ignored')).toBe(false);
        expect(manager.resize(created.terminal!.id, 120, 40)).toBe(false);

        await manager.start(created.terminal!);
        expect(manager.write(created.terminal!.id, "printf 'CAXRI_LIVE_INPUT_OK\\n'\r")).toBe(true);
        expect(manager.resize(created.terminal!.id, 120, 40)).toBe(true);
        await manager.shutdown('orderly');
        expect(manager.write(created.terminal!.id, 'ignored')).toBe(false);
        await drainTrackedPtys();
        database.close();
    });
});
