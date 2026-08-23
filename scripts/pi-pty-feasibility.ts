import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';

import { spawn } from 'node-pty';

import { processStateToAgentActivity } from '../src/runtime/agents/contract.ts';
import type { PiSpikeLifecycleEvent, PiSpikeModelServer } from './pi-pty-feasibility-support.ts';
import {
    createPiSpikeExtensionSource,
    createPiSpikeLaunch,
    createPiSpikeSessionId,
    piSpikeBaseline,
    piSpikeRequiredHelpFlags,
    readPiSpikeState,
    selectPiSpikeLifecycleEvent,
    startPiSpikeModelServer,
    verifyPiSpikeExecutable,
} from './pi-pty-feasibility-support.ts';
import { didRelaunchInElectron } from './run-in-electron.ts';

const execFileAsync = promisify(execFile);
const outputLimit = 256 * 1024;
const probeTimeoutMs = 20_000;

interface PtyExit {
    exitCode: number;
    signal: number;
}

interface PtyProbe {
    exit: Promise<PtyExit>;
    hasExited(): boolean;
    kill(signal: string): void;
    outputContains(marker: string): boolean;
    pid: number;
    waitForOutput(marker: string): Promise<void>;
    write(input: string): void;
}

function createPtyProbe(
    executable: string,
    arguments_: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
): PtyProbe {
    let output = '';
    let exitResult: PtyExit | undefined;
    const terminal = spawn(executable, arguments_, {
        cols: 100,
        cwd: options.cwd,
        env: options.env,
        name: 'xterm-256color',
        rows: 30,
    });
    terminal.onData((data) => {
        output = `${output}${data}`.slice(-outputLimit);
    });
    const exit = new Promise<PtyExit>((resolve) => {
        terminal.onExit(({ exitCode, signal }) => {
            const result = { exitCode, signal: signal ?? 0 };
            exitResult = result;
            resolve(result);
        });
    });

    return {
        exit,
        hasExited: () => exitResult !== undefined,
        pid: terminal.pid,
        kill: (signal) => terminal.kill(signal),
        outputContains: (marker) => output.includes(marker),
        waitForOutput: async (marker) => {
            const startedAt = Date.now();
            while (!output.includes(marker)) {
                if (Date.now() - startedAt > probeTimeoutMs) {
                    throw new Error(`Timed out waiting for the bounded Pi marker: ${marker}`);
                }
                if (exitResult) {
                    throw new Error(`Pi exited before emitting the bounded marker: ${marker}`);
                }
                // Sequential polling is deliberate: each sample observes the previous interval.
                // eslint-disable-next-line no-await-in-loop
                await delay(25);
            }
        },
        write: (input) => terminal.write(input),
    };
}

async function waitForLifecycleEvent(
    path: string,
    isMatch: (event: PiSpikeLifecycleEvent) => boolean,
    minimumMatches = 1,
): Promise<PiSpikeLifecycleEvent> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= probeTimeoutMs) {
        const event = selectPiSpikeLifecycleEvent(
            // eslint-disable-next-line no-await-in-loop -- each sample reads the next hook append
            await readLifecycleEvents(path),
            isMatch,
            minimumMatches,
        );
        if (event) return event;
        // eslint-disable-next-line no-await-in-loop -- bounded delay between lifecycle samples
        await delay(25);
    }
    throw new Error('Timed out waiting for a bounded Pi lifecycle event');
}

/**
 * Reads only the spike-owned hook event file. Pi's session directory remains opaque to this script: it is passed to the
 * CLI for persistence and is never enumerated or opened.
 */
async function readLifecycleEvents(path: string): Promise<PiSpikeLifecycleEvent[]> {
    let source: string;
    try {
        source = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    return source
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [kind, detail, sessionId, extra] = line.split('\t', 4);
            if (!kind || !detail || !sessionId || extra) {
                throw new Error('Invalid Pi spike lifecycle event');
            }
            return { detail, kind, sessionId };
        });
}

function killOwnedProbe(probe: PtyProbe, signal: NodeJS.Signals): void {
    if (probe.hasExited()) return;
    try {
        probe.kill(signal);
    } catch (ptyError) {
        try {
            process.kill(probe.pid, signal);
        } catch (processError) {
            if (!probe.hasExited()) {
                throw new AggregateError([ptyError], `Could not stop owned Pi probe ${probe.pid}`, {
                    cause: processError,
                });
            }
        }
    }
}

function isExpectedMissingExecutableError(error: unknown): boolean {
    const code =
        typeof error === 'object' && error !== null && 'code' in error
            ? String(Reflect.get(error, 'code'))
            : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return (
        code === 'ENOENT' ||
        code === 'ENOTDIR' ||
        /ENOENT|no such file|posix_spawnp failed/i.test(message)
    );
}

async function waitForProbeExit(
    probe: PtyProbe,
    label: string,
    timeoutMs = probeTimeoutMs,
): Promise<PtyExit> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            probe.exit,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                    try {
                        killOwnedProbe(probe, 'SIGKILL');
                        reject(new Error(`Timed out waiting for ${label} to exit`));
                    } catch (error) {
                        reject(
                            error instanceof Error
                                ? error
                                : new Error(`Could not stop ${label}`, { cause: error }),
                        );
                    }
                }, timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

async function exitPiGracefully(probe: PtyProbe): Promise<PtyExit> {
    probe.write('/caxri-exit\r');
    const result = await waitForProbeExit(probe, 'Pi graceful shutdown');
    if (result.exitCode !== 0 || result.signal !== 0) {
        throw new Error(
            `Pi graceful exit reported code ${result.exitCode}, signal ${result.signal}`,
        );
    }
    return result;
}

async function probeSignalExit(
    launch: ReturnType<typeof createPiSpikeLaunch>,
    signal: 'SIGKILL' | 'SIGTERM',
    spawnProbe: typeof createPtyProbe,
): Promise<PtyExit> {
    const probe = spawnProbe(launch.executable, launch.args, launch);
    await probe.waitForOutput('CAXRI_PI_MODEL_OK');
    killOwnedProbe(probe, signal);
    const result = await waitForProbeExit(probe, `Pi ${signal}`);
    if (signal === 'SIGTERM' && (result.exitCode !== 0 || result.signal !== 0)) {
        throw new Error(
            `SIGTERM did not produce Pi's documented graceful exit: code ${result.exitCode}, signal ${result.signal}`,
        );
    }
    if (signal === 'SIGKILL' && result.signal !== 9) {
        throw new Error(
            `SIGKILL did not produce the expected signal 9: code ${result.exitCode}, signal ${result.signal}`,
        );
    }
    return result;
}

async function run(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            'pi-bin': { type: 'string' },
            'retain-workspace': { type: 'boolean', default: false },
        },
        strict: true,
    });
    if (!values['pi-bin'])
        throw new Error('Usage: spike:pi -- --pi-bin <absolute official Pi binary>');
    const verifiedExecutable = await verifyPiSpikeExecutable(resolve(values['pi-bin']));
    const piBin = verifiedExecutable.path;

    const root = await mkdtemp(join(tmpdir(), 'caxri-pi-pty-'));
    const eventsPath = join(root, 'lifecycle.events');
    const extensionPath = join(root, 'extension.ts');
    const sessionId = createPiSpikeSessionId(randomUUID());
    const probes: PtyProbe[] = [];
    const spawnProbe: typeof createPtyProbe = (executable, arguments_, options) => {
        const probe = createPtyProbe(executable, arguments_, options);
        probes.push(probe);
        return probe;
    };
    let server: PiSpikeModelServer | undefined;
    let cleanupFailure: unknown;
    try {
        const binarySha256 = verifiedExecutable.sha256;
        server = await startPiSpikeModelServer();
        await Promise.all(
            ['config', 'home', 'project', 'sessions', 'tmp'].map((name) =>
                mkdir(join(root, name), { recursive: true }),
            ),
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
            root,
            sessionId,
        });

        const [{ stdout: versionOutput }, { stdout: helpOutput }] = await Promise.all([
            execFileAsync(piBin, ['--version'], {
                cwd: launch.cwd,
                env: launch.env,
                timeout: 5_000,
            }),
            execFileAsync(piBin, ['--help'], {
                cwd: launch.cwd,
                env: launch.env,
                timeout: 5_000,
            }),
        ]);
        const version = versionOutput.trim();
        if (version !== piSpikeBaseline.version) {
            throw new Error(`Expected Pi ${piSpikeBaseline.version}, received ${version}`);
        }
        const missingHelpFlags = piSpikeRequiredHelpFlags.filter(
            (flag) => !helpOutput.includes(flag),
        );
        if (missingHelpFlags.length > 0) {
            throw new Error(`Official Pi help omitted: ${missingHelpFlags.join(', ')}`);
        }

        const createProbe = spawnProbe(
            launch.executable,
            [...launch.args, 'Return the deterministic response marker.'],
            launch,
        );
        await Promise.all([
            createProbe.waitForOutput('CAXRI_PI_MODEL_OK'),
            waitForLifecycleEvent(
                eventsPath,
                (event) => event.kind === 'agent_end' && event.sessionId === sessionId,
            ),
        ]);
        const createExit = await exitPiGracefully(createProbe);
        await waitForLifecycleEvent(
            eventsPath,
            (event) =>
                event.kind === 'session_shutdown' &&
                event.detail === 'quit' &&
                event.sessionId === sessionId,
        );
        const createModelRequests = server.requestCount();
        if (createModelRequests !== 1) {
            throw new Error(
                `Expected one deterministic model request during create, received ${createModelRequests}`,
            );
        }

        const resumeSessionStarts = (await readLifecycleEvents(eventsPath)).filter(
            (event) => event.kind === 'session_start' && event.sessionId === sessionId,
        ).length;
        const resumeProbe = spawnProbe(launch.executable, launch.args, launch);
        await resumeProbe.waitForOutput('CAXRI_PI_MODEL_OK');
        const resumeEvent = await waitForLifecycleEvent(
            eventsPath,
            (event) => event.kind === 'session_start' && event.sessionId === sessionId,
            resumeSessionStarts + 1,
        );
        const resumeExit = await exitPiGracefully(resumeProbe);

        const interruption = await probeSignalExit(launch, 'SIGTERM', spawnProbe);
        const abnormalExit = await probeSignalExit(launch, 'SIGKILL', spawnProbe);

        const invalidArguments = [...launch.args];
        invalidArguments[invalidArguments.indexOf(sessionId)] = 'invalid session';
        const invalidProbe = spawnProbe(launch.executable, invalidArguments, launch);
        const invalidExit = await waitForProbeExit(invalidProbe, 'invalid-session Pi');
        if (invalidExit.exitCode === 0 || !invalidProbe.outputContains('Session id must be')) {
            throw new Error('Pi did not fail closed for an invalid caller-owned session id');
        }

        const missingExecutable = join(root, 'missing', 'pi');
        try {
            await access(missingExecutable);
            throw new Error('Missing Pi fixture unexpectedly exists');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        let cliMissingFailureMode: 'nonzero-exit' | 'spawn-error';
        try {
            const missingProbe = spawnProbe(missingExecutable, launch.args, launch);
            const missingExit = await waitForProbeExit(missingProbe, 'missing Pi executable');
            if (missingExit.exitCode === 0 && missingExit.signal === 0) {
                throw new Error('Missing Pi executable produced a normal exit');
            }
            cliMissingFailureMode = 'nonzero-exit';
        } catch (error) {
            if (!isExpectedMissingExecutableError(error)) throw error;
            cliMissingFailureMode = 'spawn-error';
        }

        const piState = await readPiSpikeState();
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime receipt for the no-index contract
        const isReadStateReturnedUndefined = piState === undefined;
        if (!isReadStateReturnedUndefined) {
            throw new Error('Pi spike readState must stay undefined without an official index');
        }
        const fallbackInputs: Array<[string, Parameters<typeof processStateToAgentActivity>[0]]> = [
            ['unset', undefined],
            ['starting', 'starting'],
            ['running', 'running'],
            ['stopped', 'stopped'],
            ['dead', 'dead'],
            ['failed', 'failed'],
        ];
        const processStateFallback: Record<
            string,
            ReturnType<typeof processStateToAgentActivity>
        > = Object.fromEntries(
            fallbackInputs.map(([label, state]) => [label, processStateToAgentActivity(state)]),
        );
        const lifecycleEvents = await readLifecycleEvents(eventsPath);
        const report = {
            baseline: {
                ...piSpikeBaseline,
                helpContract: 'verified',
                installedGlobally: false,
                sha256: binarySha256,
            },
            blocker: {
                code: 'REAL_MODEL_CREDENTIAL_NOT_AVAILABLE_TO_ISOLATED_RUN',
                effect: 'Real provider inference was not attempted or claimed.',
                remainingEvidence:
                    'Authenticated model response and account-specific permission prompts.',
            },
            capabilityMatrix: {
                endpoint:
                    'No standalone PTY endpoint; custom provider endpoints are extension-owned.',
                hooks: 'Documented extension lifecycle hooks observed.',
                image: 'Model descriptor accepts text and image; real-model transport remains blocked.',
                launchResume: 'Caller-owned --session-id and isolated --session-dir verified.',
                messaging:
                    'TUI interaction exists; Caxri Host messaging requires a reviewed Pi extension.',
                metadataIndex: 'Absent for standalone PTY; readState must return undefined.',
                permissionClassification:
                    '--approve/--no-approve classify project resource trust, not a tool sandbox.',
                skills: '--skill and --no-skills contract verified.',
                version,
            },
            decision: {
                productionProvider: 'NO-GO',
                ptyFeasibility: 'GO_WITH_FOLLOW_UPS',
                reasons: [
                    'The official CLI accepts structured caller-owned session identity.',
                    'Create, resume, exit, interruption, and fail-closed paths work without session-file inspection.',
                    'Production still needs narrow identity retention, a reviewed hook transport, and authenticated real-model evidence.',
                ],
            },
            matrix: {
                abnormalExit: { ...abnormalExit, status: 'passed' },
                cliMissing: { failureMode: cliMissingFailureMode, status: 'passed' },
                create: {
                    exit: createExit,
                    localModelRequests: createModelRequests,
                    sessionIdOwnedBy: 'caxri-spike',
                    status: 'passed',
                },
                invalidSession: { ...invalidExit, status: 'passed' },
                normalExit: { ...createExit, status: 'passed' },
                processInterruption: { ...interruption, status: 'passed' },
                processStateFallback: {
                    activity: processStateFallback,
                    readStateReturnedUndefined: isReadStateReturnedUndefined,
                    status: 'passed',
                },
                resume: {
                    exit: resumeExit,
                    historyMarkerRendered: resumeProbe.outputContains('CAXRI_PI_MODEL_OK'),
                    hookReason: resumeEvent.detail,
                    sameSessionId: resumeEvent.sessionId === sessionId,
                    status: 'passed',
                },
            },
            safety: {
                accountLogin: false,
                ambientEnvironmentInherited: false,
                piSessionFilesEnumeratedOrRead: false,
                realHomeUsed: false,
                structuredArgv: true,
                lifecycleEventsObserved: lifecycleEvents.length,
            },
        };
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } finally {
        for (const probe of probes) {
            try {
                killOwnedProbe(probe, 'SIGKILL');
            } catch (error) {
                cleanupFailure ??= error;
            }
        }
        for (const probe of probes) {
            try {
                // eslint-disable-next-line no-await-in-loop -- every owned probe gets an independent cleanup attempt
                await waitForProbeExit(probe, 'owned Pi cleanup');
            } catch (error) {
                cleanupFailure ??= error;
            }
        }
        try {
            await server?.close();
        } catch (error) {
            cleanupFailure ??= error;
        }
        if (!values['retain-workspace']) {
            try {
                await rm(root, { recursive: true, force: true });
            } catch (error) {
                cleanupFailure ??= error;
            }
        } else {
            process.stderr.write(`Retained isolated Pi spike workspace: ${root}\n`);
        }
    }
    if (cleanupFailure) {
        throw cleanupFailure instanceof Error
            ? cleanupFailure
            : new Error('Pi feasibility cleanup failed', { cause: cleanupFailure });
    }
}

async function didRelaunchPiProbe(): Promise<boolean> {
    if (process.versions.electron) return false;
    const root = await mkdtemp(join(tmpdir(), 'caxri-pi-electron-'));
    try {
        const home = join(root, 'home');
        const temporaryDirectory = join(root, 'tmp');
        await Promise.all([
            mkdir(home, { recursive: true }),
            mkdir(temporaryDirectory, { recursive: true }),
        ]);
        return await didRelaunchInElectron(import.meta.url, {
            args: process.argv.slice(2),
            env: {
                HOME: home,
                LANG: 'en_US.UTF-8',
                LC_ALL: 'en_US.UTF-8',
                LOGNAME: 'caxri-pi-spike',
                PATH: '/usr/bin:/bin',
                SHELL: '/bin/zsh',
                TMPDIR: temporaryDirectory,
                USER: 'caxri-pi-spike',
            },
            timeoutMs: 180_000,
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

if (!(await didRelaunchPiProbe())) {
    const { app } = await import('electron');
    try {
        await run();
        app.exit(0);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        app.exit(1);
    }
}
