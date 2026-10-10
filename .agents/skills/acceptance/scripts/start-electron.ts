import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { access, readFile, realpath, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { assertBuildOutputsFresh } from '@caxri/system';

import type { DesktopLeaseHandle } from '../../switch-worktree/scripts/desktop-lease';
import {
    acquireDesktopLease,
    beginDesktopLeaseHandoff,
    releaseDesktopLease,
    transferDesktopLease,
} from '../../switch-worktree/scripts/desktop-lease';
import {
    beginAgentFixtureLifecycle,
    completeAgentFixtureLifecycle,
} from './agent-fixture-lifecycle';
import {
    prepareAcceptanceAgentEnvironment,
    prepareAcceptanceAgentFixture,
    validateAcceptanceAgentFixture,
} from './agent-fixtures';
import { assertAcceptanceBuildCommit, readBuiltMainSource } from './build-identity';
import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    markCaseLifecycleReady,
} from './case-lifecycle';
import { prepareMacosAcceptanceApp, waitForMacosAcceptanceProcess } from './macos-app-identity';
import {
    createMacosAcceptanceLaunchController,
    settleMacosAcceptanceLaunch,
} from './macos-launch-lifecycle';
import {
    assertNativeDialogAuthorization,
    isNativeDialogAuthorized,
} from './native-dialog-authorization';
import type { DeclaredPlanFixtures } from './plan-fixtures';
import { loadAcceptanceCasePlan, validateAcceptanceCaseLaunch } from './report';
import type { RuntimeState } from './runtime-state';
import {
    discoverOwnedProcesses,
    errorCode,
    getProcessIdentity,
    isOwnedProcess,
    isOwnedRuntime,
    prepareAcceptanceUserData,
    removeOwnedUserData,
    runtimeStateSchema,
    writeRuntimeState,
} from './runtime-state';
import {
    acceptanceFixtureEnvironment,
    AMBIENT_ACCEPTANCE_ENVIRONMENT_KEYS,
} from './start-electron-environment';
import {
    hasBooleanOption,
    help,
    parseOptions,
    stringOption,
    stringOptions,
} from './start-electron-options';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RUNTIME_PATH = join(PROJECT_ROOT, '.records', 'acceptance', 'runtime.json');
const ELECTRON_PATH = join(PROJECT_ROOT, 'node_modules', '.bin', 'electron');
const ELECTRON_APP_PATH = join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
const BUILT_MAIN_PATH = join(PROJECT_ROOT, 'out', 'main', 'index.js');
const STALE_BUILD_MESSAGE = 'Build output is stale; run `bun run build` before Acceptance';
const BUILD_INPUT_PATHS = [
    join(PROJECT_ROOT, 'apps', 'desktop', 'package.json'),
    join(PROJECT_ROOT, 'apps', 'desktop', 'src'),
    join(PROJECT_ROOT, 'apps', 'desktop', 'tsconfig.node.json'),
    join(PROJECT_ROOT, 'apps', 'desktop', 'tsconfig.web.json'),
    join(PROJECT_ROOT, 'apps', 'server', 'package.json'),
    join(PROJECT_ROOT, 'apps', 'server', 'scripts'),
    join(PROJECT_ROOT, 'apps', 'server', 'src'),
    join(PROJECT_ROOT, 'apps', 'server', 'vite.config.ts'),
    join(PROJECT_ROOT, 'electron.vite.config.ts'),
    join(PROJECT_ROOT, 'package.json'),
    join(PROJECT_ROOT, 'apps', 'cli', 'package.json'),
    join(PROJECT_ROOT, 'apps', 'cli', 'scripts'),
    join(PROJECT_ROOT, 'apps', 'cli', 'src'),
    join(PROJECT_ROOT, 'apps', 'cli', 'tsconfig.build.json'),
    join(PROJECT_ROOT, 'apps', 'cli', 'tsconfig.json'),
    join(PROJECT_ROOT, 'packages'),
    join(PROJECT_ROOT, 'pnpm-lock.yaml'),
    join(PROJECT_ROOT, 'pnpm-workspace.yaml'),
    join(PROJECT_ROOT, 'tsconfig.node.json'),
    join(PROJECT_ROOT, 'tsconfig.web.json'),
];
const BUILD_OUTPUT_PATHS = [
    BUILT_MAIN_PATH,
    join(PROJECT_ROOT, 'apps', 'server', 'dist', 'server', 'metadata', 'manifest.json'),
    join(PROJECT_ROOT, 'apps', 'server', 'dist', 'server', 'bundles', 'server-core.js'),
    join(PROJECT_ROOT, 'apps', 'server', 'dist', 'server', 'bundles', 'extension-host.js'),
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
const OWNED_PROCESS_DISCOVERY_TIMEOUT_MS = 10_000;

interface ElectronLaunchSpecInput {
    caseId?: string;
    agentEnvironment?: NodeJS.ProcessEnv;
    declaredFixtures?: DeclaredPlanFixtures;
    electronPath?: string;
    environment?: NodeJS.ProcessEnv;
    port: number;
    projectRoot?: string;
    testRootPath: string;
    testRootPaths: string[];
    useTestRootFixture?: boolean;
    userDataDir: string;
}

interface MacosAcceptanceLaunchSpecInput extends Omit<ElectronLaunchSpecInput, 'electronPath'> {
    appPath: string;
}

interface WaitForCdpDependencies {
    fetch: typeof fetch;
    now: () => number;
    sleep: (milliseconds: number) => Promise<void>;
}

export interface ReadyDesktopLeaseDependencies {
    getProcessIdentity: typeof getProcessIdentity;
    transferDesktopLease: typeof transferDesktopLease;
    waitForCdp: typeof waitForCdp;
}

export interface StaleRuntimeDependencies {
    canonicalPath: (path: string) => Promise<string>;
    discoverOwnedProcesses: typeof discoverOwnedProcesses;
    isOwnedProcess: typeof isOwnedProcess;
    isOwnedRuntime: typeof isOwnedRuntime;
    projectRoot: string;
    readRuntime: () => Promise<string>;
    removeOwnedUserData: typeof removeOwnedUserData;
    runtimePath: string;
    unlinkRuntime: () => Promise<void>;
}

export interface RestartRuntimeExpectation {
    caseId: string;
    userDataDir: string;
}

export interface WaitForOwnedProcessesDependencies {
    discoverOwnedProcesses: typeof discoverOwnedProcesses;
    now: () => number;
    sleep: (milliseconds: number) => Promise<void>;
}

const defaultWaitForOwnedProcessesDependencies: WaitForOwnedProcessesDependencies = {
    discoverOwnedProcesses,
    now: Date.now,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const defaultWaitForCdpDependencies: WaitForCdpDependencies = {
    fetch,
    now: Date.now,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/**
 * Keeps the executable, structured argv, and isolated environment in one testable launch contract.
 */
export function createElectronLaunchSpec({
    caseId,
    agentEnvironment,
    declaredFixtures,
    electronPath = ELECTRON_PATH,
    environment = process.env,
    port,
    projectRoot = PROJECT_ROOT,
    testRootPath,
    testRootPaths,
    useTestRootFixture = true,
    userDataDir,
}: ElectronLaunchSpecInput) {
    if (!useTestRootFixture) assertNativeDialogAuthorization(environment);
    /**
     * Acceptance is never allowed to inherit an opt-in real provider or user-global hook policy.
     */
    const isolatedEnvironment = { ...environment };
    for (const key of AMBIENT_ACCEPTANCE_ENVIRONMENT_KEYS) delete isolatedEnvironment[key];
    return {
        args: ['apps/desktop', `--remote-debugging-port=${port}`],
        command: electronPath,
        options: {
            cwd: projectRoot,
            env: {
                ...isolatedEnvironment,
                ...(agentEnvironment ?? { CAXRI_E2E_AGENT_MODE: 'blocked' }),
                CAXRI_ACCEPTANCE: '1',
                CAXRI_E2E: '1',
                CAXRI_E2E_WINDOW_MODE: 'visible',
                ...acceptanceFixtureEnvironment({
                    caseId,
                    declared: declaredFixtures,
                    hasTestRootFixture: useTestRootFixture,
                    isNativeDialogAuthorized: isNativeDialogAuthorized(environment),
                }),
                ...(useTestRootFixture && {
                    CAXRI_TEST_ROOT_PATH: testRootPath,
                    CAXRI_TEST_ROOT_PATHS: JSON.stringify(testRootPaths),
                }),
                CAXRI_USER_DATA_DIR: userDataDir,
            },
            stdio: 'inherit' as const,
        },
    };
}

/**
 * LaunchServices registers the cloned bundle's unique identity while the stock `Electron` executable basename keeps
 * `app.isPackaged` false. `open` inherits the isolated environment without exposing its values in argv and remains
 * alive with `-W` until the launched app exits, so the existing lifecycle supervision remains deterministic.
 */
export function createMacosAcceptanceLaunchSpec({
    appPath,
    ...input
}: MacosAcceptanceLaunchSpecInput) {
    const electronLaunch = createElectronLaunchSpec(input);
    /**
     * LaunchServices does not preserve the caller's working directory for the application process. Pass the Desktop
     * workspace as an absolute application path so Electron never falls back to the repository composition root.
     */
    const desktopAppPath = resolve(electronLaunch.options.cwd, electronLaunch.args[0]);
    return {
        ...electronLaunch,
        args: ['-n', '-W', appPath, '--args', desktopAppPath, ...electronLaunch.args.slice(1)],
        command: '/usr/bin/open',
    };
}

export function createChildExitPromise(
    child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
}

const defaultStaleRuntimeDependencies: StaleRuntimeDependencies = {
    canonicalPath: realpath,
    discoverOwnedProcesses,
    isOwnedProcess,
    isOwnedRuntime,
    projectRoot: PROJECT_ROOT,
    readRuntime: () => readFile(RUNTIME_PATH, 'utf8'),
    removeOwnedUserData,
    runtimePath: RUNTIME_PATH,
    unlinkRuntime: () => unlink(RUNTIME_PATH),
};

export async function removeStaleRuntime(
    dependencies: StaleRuntimeDependencies = defaultStaleRuntimeDependencies,
    expectedRestart?: RestartRuntimeExpectation,
): Promise<RuntimeState['ownedProcesses']> {
    let rawText: string;
    try {
        rawText = await dependencies.readRuntime();
    } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') return [];
        throw error;
    }

    let current: RuntimeState;
    try {
        const raw: unknown = JSON.parse(rawText);
        current = runtimeStateSchema.parse(raw);
    } catch {
        throw new Error(
            `Invalid ${relative(dependencies.projectRoot, dependencies.runtimePath)}; inspect it before removing stale state`,
        );
    }

    if (await dependencies.isOwnedRuntime(current)) {
        throw new Error('Acceptance instance already running with a live owned process');
    }
    /**
     * An empty receipt means startup never crossed the Server process ownership boundary, so absence is not proof.
     */
    if (current.ownedProcesses.length === 0) {
        throw new Error(
            'Acceptance process ownership was never verified; runtime state and profile were preserved',
        );
    }
    const persistedLiveness = await Promise.all(
        current.ownedProcesses.map((ownedProcess) => dependencies.isOwnedProcess(ownedProcess)),
    );
    const discoveredProcesses = await dependencies.discoverOwnedProcesses(
        current,
        dependencies.projectRoot,
    );
    const isMatchingRestart = expectedRestart
        ? current.acceptanceCase?.id === expectedRestart.caseId &&
          current.acceptanceCase.mode === 'restart' &&
          (await dependencies.canonicalPath(current.projectRoot)) ===
              (await dependencies.canonicalPath(dependencies.projectRoot)) &&
          (await dependencies.canonicalPath(current.userDataDir)) ===
              (await dependencies.canonicalPath(expectedRestart.userDataDir))
        : false;
    if (isMatchingRestart && (persistedLiveness.some(Boolean) || discoveredProcesses.length > 0)) {
        /**
         * A restart may inherit the same verified Server Core generation, but never adopt a replacement profile owner.
         */
        const persistedServerCoreKeys = new Set(
            current.ownedProcesses
                .filter(({ role }) => role === 'server-core')
                .map(({ identity, pid }) => `${pid}:${identity}`),
        );
        const discoveredServerCore = discoveredProcesses.find(({ role }) => role === 'server-core');
        if (
            !discoveredServerCore ||
            !persistedServerCoreKeys.has(
                `${discoveredServerCore.pid}:${discoveredServerCore.identity}`,
            )
        ) {
            throw new Error('Acceptance restart profile owner changed process identity');
        }
        return new Map(
            [...current.ownedProcesses, ...discoveredProcesses].map((ownedProcess) => [
                `${ownedProcess.pid}:${ownedProcess.identity}`,
                ownedProcess,
            ]),
        )
            .values()
            .toArray();
    }
    if (persistedLiveness.some(Boolean) || discoveredProcesses.length > 0) {
        throw new Error(
            'Acceptance detached processes are still running; run stop-electron before starting another instance',
        );
    }
    await dependencies.unlinkRuntime();
    if (!isMatchingRestart) await dependencies.removeOwnedUserData(current);
    return [];
}

/**
 * A reused profile stays protected from cleanup while any verified inherited process receipt exists.
 */
export function shouldPreserveInheritedRuntimeState(
    inheritedOwnedProcesses: RuntimeState['ownedProcesses'],
): boolean {
    return inheritedOwnedProcesses.length > 0;
}

export async function waitForOwnedProcesses(
    runtime: Pick<RuntimeState, 'projectRoot' | 'userDataDir'>,
    expectedProjectRoot: string,
    dependencies: WaitForOwnedProcessesDependencies = defaultWaitForOwnedProcessesDependencies,
): Promise<RuntimeState['ownedProcesses']> {
    const deadline = dependencies.now() + OWNED_PROCESS_DISCOVERY_TIMEOUT_MS;
    while (true) {
        // eslint-disable-next-line no-await-in-loop -- readiness must observe one ordered Server ownership snapshot
        const processes = await dependencies.discoverOwnedProcesses(runtime, expectedProjectRoot);
        const roles = new Set(processes.map(({ role }) => role));
        if (roles.has('server-core') && roles.has('extension-host')) return processes;
        if (dependencies.now() >= deadline) {
            throw new Error('Timed out waiting for owned Acceptance Server processes');
        }
        // eslint-disable-next-line no-await-in-loop -- poll cadence is intentionally sequential
        await dependencies.sleep(100);
    }
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

export async function waitForCdp(
    port: number,
    child: ChildProcess,
    dependencies: WaitForCdpDependencies = defaultWaitForCdpDependencies,
): Promise<void> {
    const deadline = dependencies.now() + 30_000;
    // This is a poll loop: each iteration must await the previous probe and retry delay before
    // deciding whether to poll again, so the awaits below are intentionally sequential.
    while (dependencies.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Electron exited before CDP became ready (${child.exitCode})`);
        }
        try {
            // eslint-disable-next-line no-await-in-loop
            const response = await dependencies.fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) return;
        } catch {
            // The listener is expected to reject connections while Electron starts.
        }
        // eslint-disable-next-line no-await-in-loop
        await dependencies.sleep(250);
    }
    throw new Error(`Timed out waiting for CDP on port ${port}`);
}

const defaultReadyDesktopLeaseDependencies: ReadyDesktopLeaseDependencies = {
    getProcessIdentity,
    transferDesktopLease,
    waitForCdp,
};

/**
 * Keeps the launcher's handoff-pending lease until Main has set its macOS development process title and exposed CDP.
 * Capturing Electron's identity earlier records the executable argv, which becomes stale when `process.title` changes
 * to `Caxri Dev` and can let a competing desktop worker replace a still-running Acceptance lease.
 */
export async function transferDesktopLeaseAfterCdp(
    desktopLease: DesktopLeaseHandle,
    electronPid: number,
    port: number,
    child: ChildProcess,
    dependencies: ReadyDesktopLeaseDependencies = defaultReadyDesktopLeaseDependencies,
): Promise<{ desktopLease: DesktopLeaseHandle; electronIdentity: string }> {
    await dependencies.waitForCdp(port, child);
    const electronIdentity = await dependencies.getProcessIdentity(electronPid);
    if (!electronIdentity) {
        throw new Error('Could not establish ready Acceptance Electron identity');
    }
    return {
        desktopLease: await dependencies.transferDesktopLease(desktopLease, electronPid),
        electronIdentity,
    };
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

    const caseId = stringOption(options, 'case-id');
    const reportDirectory = stringOption(options, 'report-dir');
    if (!caseId || !reportDirectory) {
        throw new Error('Acceptance launch requires --case-id and --report-dir');
    }
    const caseMode = (stringOption(options, 'case-mode') ?? 'isolated') as 'isolated' | 'restart';
    const reuseUserDataDirectory = stringOption(options, 'reuse-user-data');
    const isCleanupReusable = hasBooleanOption(options, 'cleanup-reused-user-data');
    const isUseNativeDialog = hasBooleanOption(options, 'native-dialog');
    const requestedAgentFixture = stringOption(options, 'agent-fixture');
    if (isUseNativeDialog) assertNativeDialogAuthorization();

    let desktopLease = await acquireDesktopLease(PROJECT_ROOT, 'Acceptance');
    try {
        await access(ELECTRON_APP_PATH);
        await assertBuildOutputsFresh({
            inputPaths: BUILD_INPUT_PATHS,
            outputPaths: BUILD_OUTPUT_PATHS,
            staleMessage: STALE_BUILD_MESSAGE,
            watchedDirectoryExtensions: WATCHED_BUILD_INPUT_EXTENSIONS,
        });
        const inheritedOwnedProcesses = await removeStaleRuntime(
            defaultStaleRuntimeDependencies,
            caseMode === 'restart' && reuseUserDataDirectory
                ? {
                      caseId,
                      userDataDir: resolve(PROJECT_ROOT, reuseUserDataDirectory),
                  }
                : undefined,
        );
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
        const plannedCase = await loadAcceptanceCasePlan(reportDirectory, caseId);
        validateAcceptanceAgentFixture(
            caseId,
            plannedCase.item.agentFixture,
            requestedAgentFixture,
        );
        // Rejects a declared fixture this launch cannot arm before any lifecycle receipt exists.
        acceptanceFixtureEnvironment({
            caseId,
            declared: plannedCase.item,
            hasTestRootFixture: !isUseNativeDialog,
            isNativeDialogAuthorized: isNativeDialogAuthorized(),
        });
        assertAcceptanceBuildCommit({
            builtMainSource: await readBuiltMainSource(dirname(BUILT_MAIN_PATH)),
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
            requiresTerminalFixturePreflight: plannedCase.item.fixturePreflight === 'terminal',
            reuseUserDataDir: reuseUserDataDirectory,
        });
        let lifecycleLaunchId: string;
        let agentFixtureLaunchId: string | undefined;
        let hasVerifiedOwnedProcesses = false;
        let isPreserveOwnedRuntimeState =
            shouldPreserveInheritedRuntimeState(inheritedOwnedProcesses);
        let runtime: RuntimeState | undefined;
        try {
            lifecycleLaunchId = await beginCaseLifecycle(plannedCase.directory, {
                caseId,
                profileIdentity: profileId ?? basename(userDataDir),
                stateIsolation: plannedCase.item.stateIsolation,
            });
        } catch (error: unknown) {
            if (!isPreserveOwnedRuntimeState) {
                await removeOwnedUserData({ ownedUserData, userDataDir });
            }
            throw error;
        }
        try {
            const preparedAgentFixture = requestedAgentFixture
                ? await prepareAcceptanceAgentFixture({
                      fixtureId: requestedAgentFixture,
                      userDataDir,
                  })
                : undefined;
            const agentEnvironment = preparedAgentFixture
                ? preparedAgentFixture.environment
                : await prepareAcceptanceAgentEnvironment({ userDataDir });
            if (requestedAgentFixture) {
                const availableProviders = preparedAgentFixture?.executables.grok
                    ? preparedAgentFixture.executables.claude
                        ? (['claude', 'codex', 'grok'] as const)
                        : (['grok'] as const)
                    : preparedAgentFixture?.executables.codex
                      ? (['claude', 'codex'] as const)
                      : (['claude'] as const);
                agentFixtureLaunchId = await beginAgentFixtureLifecycle(plannedCase.directory, {
                    availableProviders,
                    caseId,
                    fixtureId: requestedAgentFixture,
                });
            }
            desktopLease = await beginDesktopLeaseHandoff(desktopLease);
            const acceptanceApp = await prepareMacosAcceptanceApp({
                caseId,
                sourceAppPath: ELECTRON_APP_PATH,
                userDataDir,
            });
            const launch = createMacosAcceptanceLaunchSpec({
                caseId,
                agentEnvironment,
                declaredFixtures: plannedCase.item,
                appPath: acceptanceApp.appPath,
                port,
                testRootPath,
                testRootPaths,
                useTestRootFixture: !isUseNativeDialog,
                userDataDir,
            });
            const acceptanceExecutablePath = await realpath(acceptanceApp.executablePath);
            const child = spawn(launch.command, launch.args, launch.options);
            const childExit = createChildExitPromise(child);
            async function rejectOnChildExit(): Promise<never> {
                const { code, signal } = await childExit;
                throw new Error(
                    `Electron exited before CDP was ready (${code ?? signal ?? 'unknown'})`,
                );
            }
            const launchController = createMacosAcceptanceLaunchController(
                child,
                acceptanceExecutablePath,
            );
            const { stop } = launchController;
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
            try {
                /**
                 * `mkdtemp()` reports `/var/folders/...`, while `ps` reports the same executable through macOS's
                 * canonical `/private/var/folders/...` path. Match the canonical path so an already-launched owned app
                 * cannot escape supervision because of that filesystem alias.
                 */
                const electronPid = await Promise.race([
                    waitForMacosAcceptanceProcess(acceptanceExecutablePath),
                    rejectOnChildExit(),
                ]);
                launchController.bindElectronPid(electronPid);
                const launchingElectronIdentity = await getProcessIdentity(electronPid);
                if (!launchingElectronIdentity)
                    throw new Error('Could not establish Acceptance Electron identity');
                runtime = {
                    // stop-electron completes this launch's receipt when this launcher cannot (#611).
                    acceptanceCase: {
                        ...acceptanceCase,
                        agentFixtureLaunchId,
                        lifecycleLaunchId,
                        reportDirectory: plannedCase.directory,
                    },
                    cdpUrl: `http://127.0.0.1:${port}`,
                    electronIdentity: launchingElectronIdentity,
                    electronPid,
                    launcherIdentity,
                    launcherPid: process.pid,
                    ownedProcesses: inheritedOwnedProcesses,
                    ownedUserData,
                    port,
                    projectRoot: PROJECT_ROOT,
                    startedAt: new Date().toISOString(),
                    testRootPath,
                    testRootPaths,
                    userDataDir,
                };
                isPreserveOwnedRuntimeState = true;
                await writeRuntimeState(RUNTIME_PATH, runtime);
                const readyLease = await Promise.race([
                    transferDesktopLeaseAfterCdp(desktopLease, electronPid, port, child),
                    rejectOnChildExit(),
                ]);
                desktopLease = readyLease.desktopLease;
                runtime.electronIdentity = readyLease.electronIdentity;
                runtime.ownedProcesses = await waitForOwnedProcesses(runtime, PROJECT_ROOT);
                hasVerifiedOwnedProcesses = true;
                await writeRuntimeState(RUNTIME_PATH, runtime);
                await markCaseLifecycleReady(plannedCase.directory, {
                    caseId,
                    launchId: lifecycleLaunchId,
                });
                console.log(JSON.stringify({ ...runtime, status: 'ready' }));
                const { code, signal } = await childExit;
                // `isStopping` can flip to `true` asynchronously (SIGINT/SIGTERM handler calling
                // `stop()`) while the awaits above are pending; the type checker's synchronous
                // control-flow analysis can't see that interruption, but a real shutdown must not
                // be reported as an unexpected non-zero exit.
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
                if (code !== 0 && !launchController.isStopping) {
                    throw new Error(`Electron exited with code ${code} (${signal ?? 'no signal'})`);
                }
            } finally {
                const cleanupResult = await settleMacosAcceptanceLaunch(
                    launchController,
                    childExit,
                    () => {
                        process.off('SIGINT', stop);
                        process.off('SIGTERM', stop);
                    },
                );
                if (!cleanupResult.isSafeToRemoveProfile) {
                    isPreserveOwnedRuntimeState = true;
                    // Cleanup failure must replace the in-flight launch error because it means an owned process may
                    // still be alive. Preserving the unique profile path is the recovery contract for that orphan.
                    // eslint-disable-next-line no-unsafe-finally
                    throw cleanupResult.cleanupError;
                }
                const detachedProcesses = runtime
                    ? await discoverOwnedProcesses(runtime, PROJECT_ROOT)
                    : [];
                if (runtime && detachedProcesses.length > 0) {
                    const recordedProcessKeys = new Set(
                        runtime.ownedProcesses.map(({ identity, pid }) => `${pid}:${identity}`),
                    );
                    runtime.ownedProcesses.push(
                        ...detachedProcesses.filter(
                            ({ identity, pid }) => !recordedProcessKeys.has(`${pid}:${identity}`),
                        ),
                    );
                    await writeRuntimeState(RUNTIME_PATH, runtime);
                }
                /**
                 * Server Core owns the profile lock, but a child may survive after Core exits and be reparented. Keep
                 * runtime.json while any identity captured at CDP readiness is still alive so stop-electron can recover
                 * that orphan without scanning unrelated worktrees or profiles.
                 */
                const hasRecordedProcess = runtime
                    ? (
                          await Promise.all(
                              runtime.ownedProcesses.map((ownedProcess) =>
                                  isOwnedProcess(ownedProcess),
                              ),
                          )
                      ).some(Boolean)
                    : false;
                if (
                    hasVerifiedOwnedProcesses &&
                    !hasRecordedProcess &&
                    detachedProcesses.length === 0
                ) {
                    try {
                        await unlink(RUNTIME_PATH);
                        isPreserveOwnedRuntimeState = false;
                    } catch (error: unknown) {
                        // A non-ENOENT failure to remove the owned runtime.json is itself an
                        // unexpected filesystem error worth surfacing over an in-flight launch
                        // failure; this intentionally preserves the pre-existing
                        // `.catch()`-chain masking behavior rather than silently swallowing it.
                        // eslint-disable-next-line no-unsafe-finally
                        if (errorCode(error) !== 'ENOENT') throw error;
                        isPreserveOwnedRuntimeState = false;
                    }
                }
            }
        } finally {
            let isCleanupCompleted = false;
            try {
                if (!isPreserveOwnedRuntimeState) {
                    await removeOwnedUserData({ ownedUserData, userDataDir });
                    isCleanupCompleted = ownedUserData;
                }
            } finally {
                try {
                    await completeCaseLifecycle(plannedCase.directory, {
                        caseId,
                        cleanupCompleted: isCleanupCompleted,
                        cleanupRequested: ownedUserData,
                        launchId: lifecycleLaunchId,
                    });
                } finally {
                    if (agentFixtureLaunchId) {
                        await completeAgentFixtureLifecycle(plannedCase.directory, {
                            caseId,
                            cleanupCompleted: isCleanupCompleted,
                            launchId: agentFixtureLaunchId,
                            sharedProfile: plannedCase.item.stateIsolation.mode === 'restart',
                        });
                    }
                }
            }
        }
    } finally {
        await releaseDesktopLease(desktopLease);
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
