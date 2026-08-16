import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { assertBuildOutputsFresh } from '../../../../src/shared/node/build-freshness';
import {
    acquireDesktopLease,
    beginDesktopLeaseHandoff,
    releaseDesktopLease,
    transferDesktopLease,
} from '../../switch-worktree/scripts/desktop-lease';
import { assertAcceptanceBuildCommit } from './build-identity';
import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    loadAcceptanceCasePlan,
    markCaseLifecycleReady,
    validateAcceptanceCaseLaunch,
} from './report';
import type { RuntimeState } from './runtime-state';
import {
    errorCode,
    getProcessIdentity,
    isAlive,
    isOwnedRuntime,
    prepareAcceptanceUserData,
    removeOwnedUserData,
    runtimeStateSchema,
} from './runtime-state';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RUNTIME_PATH = join(PROJECT_ROOT, '.records', 'acceptance', 'runtime.json');
const ELECTRON_PATH = join(PROJECT_ROOT, 'node_modules', '.bin', 'electron');
const BUILT_MAIN_PATH = join(PROJECT_ROOT, 'out', 'main', 'index.js');
const STALE_BUILD_MESSAGE = 'Build output is stale; run `bun run build` before Acceptance';
const BUILD_INPUT_PATHS = [
    join(PROJECT_ROOT, 'src'),
    join(PROJECT_ROOT, 'electron.vite.config.ts'),
    join(PROJECT_ROOT, 'package.json'),
    join(PROJECT_ROOT, 'packages', 'cli', 'package.json'),
    join(PROJECT_ROOT, 'packages', 'cli', 'scripts'),
    join(PROJECT_ROOT, 'packages', 'cli', 'src'),
    join(PROJECT_ROOT, 'packages', 'cli', 'tsconfig.build.json'),
    join(PROJECT_ROOT, 'packages', 'cli', 'tsconfig.json'),
    join(PROJECT_ROOT, 'packages', 'protocol', 'package.json'),
    join(PROJECT_ROOT, 'packages', 'protocol', 'src'),
    join(PROJECT_ROOT, 'packages', 'protocol', 'tsconfig.build.json'),
    join(PROJECT_ROOT, 'packages', 'protocol', 'tsconfig.json'),
    join(PROJECT_ROOT, 'pnpm-lock.yaml'),
    join(PROJECT_ROOT, 'pnpm-workspace.yaml'),
    join(PROJECT_ROOT, 'tsconfig.node.json'),
    join(PROJECT_ROOT, 'tsconfig.web.json'),
];
const BUILD_OUTPUT_PATHS = [
    BUILT_MAIN_PATH,
    join(PROJECT_ROOT, 'out', 'main', 'runtime.js'),
    join(PROJECT_ROOT, 'out', 'preload', 'index.cjs'),
    join(PROJECT_ROOT, 'out', 'preload', 'process-explorer.cjs'),
    join(PROJECT_ROOT, 'out', 'renderer', 'index.html'),
    join(PROJECT_ROOT, 'out', 'renderer', 'process-explorer.html'),
];
const WATCHED_BUILD_INPUT_EXTENSIONS = new Set([
    '.css',
    '.html',
    '.json',
    '.png',
    '.svg',
    '.ts',
    '.tsx',
    '.ttf',
    '.woff',
    '.woff2',
]);

type OptionValue = string | true;
type ParsedOptions = Record<string, OptionValue[]>;

function parseOptions(argv: string[]): ParsedOptions {
    const options: ParsedOptions = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) throw new Error(`Expected an option, received: ${token}`);
        const key = token.slice(2);
        const next = argv[index + 1];
        (options[key] ??= []).push(next && !next.startsWith('--') ? argv[++index] : true);
    }
    return options;
}

function stringOptions(options: ParsedOptions, key: string): string[] {
    const values = options[key] ?? [];
    if (values.includes(true)) throw new Error(`--${key} requires a value`);
    return values as string[];
}

function stringOption(options: ParsedOptions, key: string): string | undefined {
    const values = options[key] ?? [];
    if (values.length > 1) throw new Error(`--${key} may only be provided once`);
    const value = values[0];
    if (value === true) throw new Error(`--${key} requires a value`);
    return value;
}

function hasBooleanOption(options: ParsedOptions, key: string): boolean {
    const values = options[key] ?? [];
    if (values.length > 1) throw new Error(`--${key} may only be provided once`);
    if (values.some((value) => value !== true)) throw new Error(`--${key} does not take a value`);
    return values.length === 1;
}

function help(): string {
    return `Start an isolated Caxri Electron acceptance instance

Options:
  --port N               CDP port (default: 9222)
  --test-root PATH       Project root selected in Caxri; repeat to queue roots (default: repository root)
  --case-id ID           Stable lowercase id for this isolated Acceptance case
  --report-dir DIR       Frozen round containing this case plan and lifecycle evidence
  --case-mode MODE       isolated (default) or restart
  --reuse-user-data PATH Reuse this case's frozen caxri-acceptance-user-<profile-id>-* profile
  --cleanup-reused-user-data
                         Remove the validated reusable profile when this launch stops
  --help                 Show this message`;
}

async function removeStaleRuntime(): Promise<void> {
    let rawText: string;
    try {
        rawText = await readFile(RUNTIME_PATH, 'utf8');
    } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
    }

    let current: RuntimeState;
    try {
        const raw: unknown = JSON.parse(rawText);
        current = runtimeStateSchema.parse(raw);
    } catch {
        throw new Error(
            `Invalid ${relative(PROJECT_ROOT, RUNTIME_PATH)}; inspect it before removing stale state`,
        );
    }

    /**
     * Preserve a verified live owner; only stale identity can release its state.
     */
    if (await isOwnedRuntime(current)) {
        throw new Error('Acceptance instance already running with a live owned process');
    }
    await unlink(RUNTIME_PATH);
    await removeOwnedUserData(current);
}

async function assertPortAvailable(port: number): Promise<void> {
    const server = createServer();
    server.unref();
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', resolve);
        });
    } catch (error: unknown) {
        if (errorCode(error) === 'EADDRINUSE')
            throw new Error(`CDP port ${port} is already in use`, { cause: error });
        throw error;
    }
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
}

async function writeRuntime(state: RuntimeState): Promise<void> {
    await mkdir(dirname(RUNTIME_PATH), { recursive: true });
    const temporary = `${RUNTIME_PATH}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, RUNTIME_PATH);
}

async function waitForCdp(port: number, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 30_000;
    // This is a poll loop: each iteration must await the previous probe and retry delay before
    // deciding whether to poll again, so the awaits below are intentionally sequential.
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Electron exited before CDP became ready (${child.exitCode})`);
        }
        try {
            // eslint-disable-next-line no-await-in-loop
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) return;
        } catch {
            // The listener is expected to reject connections while Electron starts.
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for CDP on port ${port}`);
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    if (options.help?.length) {
        console.log(help());
        return;
    }

    const port = Number(stringOption(options, 'port') ?? 9222);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
        throw new Error('--port must be an integer between 1024 and 65535');
    }

    let desktopLease = await acquireDesktopLease(PROJECT_ROOT, 'Acceptance');
    try {
        await access(ELECTRON_PATH);
        await assertBuildOutputsFresh({
            inputPaths: BUILD_INPUT_PATHS,
            outputPaths: BUILD_OUTPUT_PATHS,
            staleMessage: STALE_BUILD_MESSAGE,
            watchedDirectoryExtensions: WATCHED_BUILD_INPUT_EXTENSIONS,
        });
        await removeStaleRuntime();
        await assertPortAvailable(port);

        const requestedRoots = stringOptions(options, 'test-root');
        const testRootPaths = (requestedRoots.length > 0 ? requestedRoots : [PROJECT_ROOT]).map(
            (root) => resolve(PROJECT_ROOT, root),
        );
        await Promise.all(
            testRootPaths.map(async (root) => {
                try {
                    await access(root);
                } catch {
                    throw new Error(`Test root does not exist: ${root}`);
                }
            }),
        );
        const testRootPath = testRootPaths[0];
        const caseId = stringOption(options, 'case-id');
        const reportDirectory = stringOption(options, 'report-dir');
        if (!caseId || !reportDirectory) {
            throw new Error('Acceptance launch requires --case-id and --report-dir');
        }
        const caseMode = (stringOption(options, 'case-mode') ?? 'isolated') as
            'isolated' | 'restart';
        const reuseUserDataDirectory = stringOption(options, 'reuse-user-data');
        const isCleanupReusable = hasBooleanOption(options, 'cleanup-reused-user-data');
        const plannedCase = await loadAcceptanceCasePlan(reportDirectory, caseId);
        assertAcceptanceBuildCommit({
            builtMainSource: await readFile(BUILT_MAIN_PATH, 'utf8'),
            reportCommit: plannedCase.commit,
        });
        const { profileId } = validateAcceptanceCaseLaunch(plannedCase.item.stateIsolation, {
            caseMode,
            cleanupReusable: isCleanupReusable,
            reuseUserData: Boolean(reuseUserDataDirectory),
        });
        const launcherIdentity = await getProcessIdentity(process.pid);
        if (!launcherIdentity) throw new Error('Could not establish Acceptance launcher identity');
        const { acceptanceCase, ownedUserData, userDataDir } = await prepareAcceptanceUserData({
            caseId,
            caseMode,
            cleanupReusable: isCleanupReusable,
            profileId,
            reuseUserDataDir: reuseUserDataDirectory,
        });
        let lifecycleLaunchId: string;
        try {
            lifecycleLaunchId = await beginCaseLifecycle(plannedCase.directory, {
                caseId,
                profileIdentity: profileId ?? basename(userDataDir),
                stateIsolation: plannedCase.item.stateIsolation,
            });
        } catch (error: unknown) {
            await removeOwnedUserData({ ownedUserData, userDataDir });
            throw error;
        }

        try {
            desktopLease = await beginDesktopLeaseHandoff(desktopLease);
            const child = spawn(ELECTRON_PATH, ['.', `--remote-debugging-port=${port}`], {
                cwd: PROJECT_ROOT,
                env: {
                    ...process.env,
                    CAXRI_E2E: '1',
                    CAXRI_E2E_WINDOW_MODE: 'visible',
                    CAXRI_TEST_ROOT_PATH: testRootPath,
                    CAXRI_TEST_ROOT_PATHS: JSON.stringify(testRootPaths),
                    CAXRI_USER_DATA_DIR: userDataDir,
                },
                stdio: 'inherit',
            });
            const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
                (resolve, reject) => {
                    child.once('error', reject);
                    child.once('exit', (code, signal) => resolve({ code, signal }));
                },
            );
            async function rejectOnChildExit(): Promise<never> {
                const { code, signal } = await childExit;
                throw new Error(
                    `Electron exited before CDP was ready (${code ?? signal ?? 'unknown'})`,
                );
            }
            let isStopping = false;
            const stop = (): void => {
                if (isStopping) return;
                isStopping = true;
                if (isAlive(child.pid)) child.kill('SIGTERM');
                const forceTimer = setTimeout(() => {
                    if (isAlive(child.pid)) child.kill('SIGKILL');
                }, 5_000);
                forceTimer.unref();
            };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
            try {
                const electronPid = child.pid;
                if (!electronPid) throw new Error('Could not establish Acceptance Electron PID');
                const electronIdentity = await getProcessIdentity(electronPid);
                if (!electronIdentity)
                    throw new Error('Could not establish Acceptance Electron identity');
                desktopLease = await transferDesktopLease(desktopLease, electronPid);
                const runtime: RuntimeState = {
                    acceptanceCase,
                    cdpUrl: `http://127.0.0.1:${port}`,
                    electronIdentity,
                    electronPid,
                    launcherIdentity,
                    launcherPid: process.pid,
                    ownedUserData,
                    port,
                    startedAt: new Date().toISOString(),
                    testRootPath,
                    testRootPaths,
                    userDataDir,
                };
                await writeRuntime(runtime);
                await Promise.race([waitForCdp(port, child), rejectOnChildExit()]);
                await markCaseLifecycleReady(plannedCase.directory, {
                    caseId,
                    launchId: lifecycleLaunchId,
                });
                console.log(JSON.stringify({ ...runtime, status: 'ready' }));
                const { code, signal } = await childExit;
                if (!isStopping && code !== 0) {
                    throw new Error(`Electron exited with code ${code} (${signal ?? 'no signal'})`);
                }
            } finally {
                stop();
                try {
                    await childExit;
                } catch {
                    // Ignored during cleanup; the process is already being torn down.
                }
                process.off('SIGINT', stop);
                process.off('SIGTERM', stop);
                try {
                    await unlink(RUNTIME_PATH);
                } catch (error: unknown) {
                    // A non-ENOENT failure to remove the owned runtime.json is itself an
                    // unexpected filesystem error worth surfacing over an in-flight launch
                    // failure; this intentionally preserves the pre-existing
                    // `.catch()`-chain masking behavior rather than silently swallowing it.
                    // eslint-disable-next-line no-unsafe-finally
                    if (errorCode(error) !== 'ENOENT') throw error;
                }
            }
        } finally {
            let isCleanupCompleted = false;
            try {
                await removeOwnedUserData({ ownedUserData, userDataDir });
                isCleanupCompleted = ownedUserData;
            } finally {
                await completeCaseLifecycle(plannedCase.directory, {
                    caseId,
                    cleanupCompleted: isCleanupCompleted,
                    cleanupRequested: ownedUserData,
                    launchId: lifecycleLaunchId,
                });
            }
        }
    } finally {
        await releaseDesktopLease(desktopLease);
    }
}

try {
    await main();
} catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
