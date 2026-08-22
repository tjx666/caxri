import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

import { connectToHost, discoverHostManifest } from '@caxri/cli';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { _electron as electron } from 'playwright';

import type { DesktopLeaseHandle } from '../../.agents/skills/switch-worktree/scripts/desktop-lease.ts';
import {
    acquireDesktopLease,
    beginDesktopLeaseHandoff,
    releaseDesktopLease,
    transferDesktopLease,
} from '../../.agents/skills/switch-worktree/scripts/desktop-lease.ts';
import type { AgentProvider } from '../../src/shared/agents.ts';
import { agentProviderCatalog } from '../../src/shared/agents.ts';
import { createBuildFreshnessGuard } from '../../src/shared/node/build-freshness.ts';
import {
    e2eAgentPolicyEnvironment,
    e2eAgentShellShims,
    e2eFakeExecutableEnvironmentKeys,
} from '../../src/shared/node/e2e-agent-policy.ts';
import {
    createE2EAgentIsolationEnvironment,
    e2eAgentStateEnvironmentKeys,
    selectE2ERealAgentStateEnvironment,
} from './agent-environment.ts';
import type { ClipboardFixture, ClipboardSnapshot } from './clipboard.ts';
import {
    armClipboardRestoreOnQuit,
    restoreClipboard,
    snapshotClipboard,
    writeClipboardFixture,
} from './clipboard.ts';
import { registerE2ELaunch } from './error-gate.ts';
import { resolveE2EWorkerIsolation } from './worker-isolation.ts';

const projectRoot = resolve(import.meta.dirname, '../..');
const staleBuildMessage = 'Build output is stale — run "bun run build" before running e2e specs.';
const buildInputPaths = [
    join(projectRoot, 'src'),
    join(projectRoot, 'electron.vite.config.ts'),
    join(projectRoot, 'package.json'),
    join(projectRoot, 'packages', 'cli', 'package.json'),
    join(projectRoot, 'packages', 'cli', 'scripts'),
    join(projectRoot, 'packages', 'cli', 'src'),
    join(projectRoot, 'packages', 'cli', 'tsconfig.build.json'),
    join(projectRoot, 'packages', 'cli', 'tsconfig.json'),
    join(projectRoot, 'packages', 'protocol', 'package.json'),
    join(projectRoot, 'packages', 'protocol', 'src'),
    join(projectRoot, 'packages', 'protocol', 'tsconfig.build.json'),
    join(projectRoot, 'packages', 'protocol', 'tsconfig.json'),
    join(projectRoot, 'pnpm-lock.yaml'),
    join(projectRoot, 'pnpm-workspace.yaml'),
    join(projectRoot, 'tsconfig.node.json'),
    join(projectRoot, 'tsconfig.web.json'),
];
const buildOutputPaths = [
    join(projectRoot, 'out', 'main', 'index.js'),
    join(projectRoot, 'out', 'main', 'host.js'),
    join(projectRoot, 'out', 'main', 'runtime.js'),
    join(projectRoot, 'out', 'preload', 'index.cjs'),
    join(projectRoot, 'out', 'preload', 'process-explorer.cjs'),
    join(projectRoot, 'out', 'renderer', 'index.html'),
    join(projectRoot, 'out', 'renderer', 'process-explorer.html'),
];
const watchedBuildInputExtensions = new Set([
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
const e2eAgentEnvironmentKeys = [
    'CAXRI_E2E_AGENT_MODE',
    'CAXRI_E2E_AGENT_PROVIDER',
    ...e2eFakeExecutableEnvironmentKeys(),
    ...e2eAgentStateEnvironmentKeys,
] as const;

/**
 * Guards against testing stale build output. The standard focused entrypoint (`bun run --silent check e2e/foo.e2e.ts
 * --e2e`) builds first, while direct Playwright invocations may skip that step and otherwise silently launch a
 * previously built `out/main/index.js`.
 */
const buildFreshnessGuard = createBuildFreshnessGuard({
    inputPaths: buildInputPaths,
    outputPaths: buildOutputPaths,
    watchedDirectoryExtensions: watchedBuildInputExtensions,
    staleMessage: staleBuildMessage,
});

async function assertBuildIsFresh(): Promise<void> {
    await buildFreshnessGuard.assertFresh();
}

export interface LaunchCaxriOptions {
    /**
     * Electron `userData` directory; callers create this with `mkdtemp`.
     */
    userDataDir: string;
    /**
     * Project root exposed to the app through `CAXRI_TEST_ROOT_PATH`.
     */
    testRootPath: string;
    /**
     * Extra environment variables layered over `process.env` and the Caxri E2E defaults below. Agent executables and
     * provider state belong in `agentMode`; use this only for a scenario-specific shell or tool environment.
     */
    env?: NodeJS.ProcessEnv;
    /**
     * Launches a packaged build instead of `.` (used by the startup benchmark).
     */
    executablePath?: string;
    /**
     * Hidden by default; use visible only for native focus, pointer, or desktop behavior.
     */
    windowMode?: 'hidden' | 'visible';
    /**
     * Keeps deterministic software rendering by default; WebGL renderer specs opt into GPU.
     */
    gpuMode?: 'disabled' | 'enabled';
    /**
     * Blocks host Agents by default; fake and real modes require an explicit per-spec choice.
     */
    agentMode?: E2EAgentMode;
    /**
     * Restart workflows let the next launch inherit the same live Host; the final launch cleans it.
     */
    preserveHostOnClose?: boolean;
    /**
     * Seeds a native pasteboard fixture after the shared desktop lease is held and restores the pre-launch clipboard
     * after the launch's own format-complete restoration has been verified.
     */
    clipboardFixture?: ClipboardFixture;
}

export interface RunningCaxri {
    app: ElectronApplication;
    clipboard: ClipboardSnapshot;
    page: Page;
}

type E2EAgentMode =
    | { mode: 'blocked' }
    | {
          mode: 'fake';
          environment: NodeJS.ProcessEnv;
          executables: Partial<Record<AgentProvider, string>>;
      }
    | { mode: 'real'; provider?: AgentProvider };

async function e2eAgentEnvironment(
    userDataDirectory: string,
    agentMode: E2EAgentMode,
    sourceEnvironment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
    if (agentMode.mode === 'real') {
        const provider = agentMode.provider ?? 'codex';
        return {
            ...selectE2ERealAgentStateEnvironment(provider, sourceEnvironment),
            ...e2eAgentPolicyEnvironment({ mode: 'real', provider }),
        };
    }
    const fixtureRoot = join(userDataDirectory, 'e2e-agents');
    const isolatedEnvironment = await createE2EAgentIsolationEnvironment(fixtureRoot);

    const fakeExecutables = agentMode.mode === 'fake' ? agentMode.executables : {};
    if (agentMode.mode === 'fake') {
        for (const executable of Object.values(agentMode.executables)) {
            if (executable && !isAbsolute(executable))
                throw new Error('Fake Agent executables must use absolute paths');
        }
        Object.assign(isolatedEnvironment, agentMode.environment);
    }

    const shellBin = join(fixtureRoot, 'shell-bin');
    await mkdir(shellBin, { recursive: true });
    await Promise.all(
        e2eAgentShellShims(fakeExecutables).map(async (shim) => {
            const executable = join(shellBin, shim.executable);
            await writeFile(executable, shim.source, 'utf8');
            await chmod(executable, 0o700);
        }),
    );
    const shellPath = `${shellBin}:${sourceEnvironment.PATH ?? process.env.PATH ?? '/usr/bin:/bin'}`;
    const profile = `export PATH=${shellQuote(shellPath)}\n`;
    const isolatedHome = isolatedEnvironment.HOME;
    if (!isolatedHome || !isAbsolute(isolatedHome))
        throw new Error('Isolated E2E Agent HOME must be an absolute path');
    await Promise.all([
        writeFile(join(isolatedHome, '.zprofile'), profile, { encoding: 'utf8', mode: 0o600 }),
        writeFile(join(isolatedHome, '.bash_profile'), profile, {
            encoding: 'utf8',
            mode: 0o600,
        }),
        writeFile(join(isolatedHome, '.profile'), profile, { encoding: 'utf8', mode: 0o600 }),
    ]);
    return {
        ...isolatedEnvironment,
        PATH: shellPath,
        ...e2eAgentPolicyEnvironment(
            agentMode.mode === 'fake'
                ? { mode: 'fake', executables: fakeExecutables }
                : { mode: 'blocked' },
        ),
    };
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

async function stopE2EHost(userDataDirectory: string): Promise<void> {
    let client: Awaited<ReturnType<typeof connectToHost>> | undefined;
    try {
        client = await connectToHost(userDataDirectory, 2_000);
        await client.request('host.stop', { confirmLivePtys: true });
    } catch (error) {
        if (errorCode(error) !== 'NOT_FOUND' && errorCode(error) !== 'UNAVAILABLE') throw error;
        return;
    } finally {
        client?.close();
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            // Sequential polling by design: each attempt depends on the previous one finishing.
            // eslint-disable-next-line no-await-in-loop
            await discoverHostManifest(userDataDirectory);
        } catch (error) {
            if (errorCode(error) === 'NOT_FOUND') return;
            throw error;
        }
        // eslint-disable-next-line no-await-in-loop -- deliberate delay between poll attempts
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for the E2E Host to stop');
}

/**
 * Waits for the asynchronous New Terminal action to become observable through Runtime state.
 */
export async function waitForNewTerminalId(
    page: Page,
    existingIds: readonly string[],
): Promise<string> {
    let newTerminalId: string | undefined;
    await expect
        .poll(async () => {
            const bootstrap = await pageRequest<{ terminals: Array<{ id: string }> }>(
                page,
                'app.bootstrap',
            );
            newTerminalId = bootstrap.terminals.find(
                (terminal) => !existingIds.includes(terminal.id),
            )?.id;
            return newTerminalId;
        })
        .toBeTruthy();
    return newTerminalId!;
}

/**
 * Launches the Caxri Electron app for e2e tests without waiting for the Runtime to become ready. Most specs should use
 * {@link launchCaxri} instead; this lower-level entry point exists for specs (eg. the startup benchmark) that need to
 * measure the readiness wait themselves.
 */
export async function launchCaxriApp(options: LaunchCaxriOptions): Promise<RunningCaxri> {
    await assertBuildIsFresh();
    const {
        userDataDir,
        testRootPath,
        env: environment = {},
        executablePath,
        gpuMode = 'disabled',
        windowMode = 'hidden',
        agentMode = { mode: 'blocked' },
        preserveHostOnClose = false,
        clipboardFixture,
    } = options;
    const agentEnvironment = await e2eAgentEnvironment(userDataDir, agentMode, environment);
    const workerIsolation = resolveE2EWorkerIsolation(process.env);
    const launchEnvironmentSource: NodeJS.ProcessEnv = {
        ...process.env,
        ...environment,
        ...agentEnvironment,
        CAXRI_E2E: '1',
        CAXRI_E2E_WINDOW_MODE: windowMode,
        CAXRI_USER_DATA_DIR: userDataDir,
        CAXRI_TEST_ROOT_PATH: testRootPath,
        ...(workerIsolation.workerNamespace && {
            CAXRI_E2E_WORKER_NAMESPACE: workerIsolation.workerNamespace,
        }),
    };
    /**
     * Prevent ambient internal test switches from adding an undeclared fake provider.
     */
    for (const key of e2eAgentEnvironmentKeys) {
        if (!Object.hasOwn(agentEnvironment, key)) delete launchEnvironmentSource[key];
    }
    const launchEnvironment = Object.fromEntries(
        Object.entries(launchEnvironmentSource).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    );
    let lease: DesktopLeaseHandle = await acquireDesktopLease(
        projectRoot,
        executablePath ? 'performance benchmark' : 'Electron E2E',
        process.pid,
        {
            coordinatorToken: workerIsolation.coordinatorToken,
            namespace: workerIsolation.leaseNamespace,
        },
    );
    let releasePromise: Promise<void> | undefined;
    const releaseLease = (): Promise<void> => (releasePromise ??= releaseDesktopLease(lease));
    let app: ElectronApplication;
    let clipboardBaseline: ClipboardSnapshot | undefined;
    let clipboardSnapshot: ClipboardSnapshot | undefined;
    try {
        lease = await beginDesktopLeaseHandoff(lease);
        app = await electron.launch({
            ...(executablePath && { executablePath }),
            args: executablePath
                ? gpuMode === 'enabled'
                    ? []
                    : ['--disable-gpu']
                : gpuMode === 'enabled'
                  ? ['.']
                  : ['.', '--disable-gpu'],
            cwd: projectRoot,
            env: launchEnvironment,
        });
        let clipboardRestoreFailure: Error | undefined;
        let cleanupPromise: Promise<void> | undefined;
        const cleanup = (): Promise<void> =>
            (cleanupPromise ??= (async () => {
                let failure: unknown;
                try {
                    await clipboardSnapshot?.dispose();
                } catch (error) {
                    clipboardRestoreFailure =
                        error instanceof Error
                            ? error
                            : new Error('E2E clipboard cleanup failed with a non-Error value');
                    failure = clipboardRestoreFailure;
                }
                try {
                    const outcome = await clipboardSnapshot?.restoreOutcome();
                    if (clipboardBaseline && outcome?.status !== 'skipped-external-write') {
                        if (outcome?.status === 'restored') {
                            clipboardBaseline.claimGeneration(outcome.generation);
                        }
                        await clipboardBaseline.restore();
                    }
                    await clipboardBaseline?.dispose();
                } catch (error) {
                    clipboardRestoreFailure =
                        error instanceof Error
                            ? error
                            : new Error('E2E clipboard cleanup failed with a non-Error value');
                    failure ??= clipboardRestoreFailure;
                }
                try {
                    if (!preserveHostOnClose) await stopE2EHost(userDataDir);
                } catch (error) {
                    failure ??= error;
                }
                try {
                    await releaseLease();
                } catch (error) {
                    failure ??= error;
                }
                /**
                 * Specs intentionally ignore direct close failures in `finally`; the shared error gate awaits this
                 * cleanup promise too, so carrying a clipboard failure here keeps it observable after Electron closes.
                 */
                failure ??= clipboardRestoreFailure;
                if (failure) {
                    throw failure instanceof Error
                        ? failure
                        : new Error('E2E cleanup failed with a non-Error value');
                }
            })());
        try {
            if (clipboardFixture) {
                clipboardBaseline = await snapshotClipboard();
                const fixtureMetadata = await writeClipboardFixture(clipboardFixture);
                clipboardBaseline.claimGeneration(fixtureMetadata.generation);
            }
            clipboardSnapshot = await snapshotClipboard();
            await armClipboardRestoreOnQuit(app, clipboardSnapshot);
        } catch (error) {
            let failure: unknown = error;
            try {
                await app.close();
            } catch (closeError) {
                failure ??= closeError;
            }
            try {
                await cleanup();
            } catch (cleanupError) {
                failure ??= cleanupError;
            }
            throw failure instanceof Error
                ? failure
                : new Error('E2E clipboard setup failed with a non-Error value');
        }
        const activeClipboardSnapshot = clipboardSnapshot;
        const electronProcess = app.process();
        const close = app.close.bind(app);
        Object.defineProperty(app, 'close', {
            configurable: true,
            value: async () => {
                if (electronProcess.exitCode !== null || electronProcess.signalCode !== null) {
                    await cleanup();
                    return;
                }
                let failure: unknown;
                try {
                    await restoreClipboard(activeClipboardSnapshot);
                } catch (error) {
                    clipboardRestoreFailure =
                        error instanceof Error
                            ? error
                            : new Error('E2E clipboard restoration failed with a non-Error value');
                    failure = clipboardRestoreFailure;
                }
                try {
                    await close();
                } catch (error) {
                    failure ??= error;
                }
                try {
                    await cleanup();
                } catch (error) {
                    failure ??= error;
                }
                if (failure)
                    throw failure instanceof Error
                        ? failure
                        : new Error('E2E application cleanup failed with a non-Error value');
            },
        });
        registerE2ELaunch(app, userDataDir, cleanup);
        const electronPid = electronProcess.pid;
        if (!electronPid) throw new Error('Could not establish the Electron process identity');
        lease = await transferDesktopLease(lease, electronPid);
    } catch (error) {
        await releaseLease();
        throw error;
    }
    try {
        const page = await app.firstWindow();
        return { app, clipboard: clipboardSnapshot, page };
    } catch (error) {
        try {
            await app.close();
        } catch {
            // Ignore close failures while unwinding a failed launch.
        }
        try {
            await releaseLease();
        } catch {
            // Ignore release failures while unwinding a failed launch.
        }
        throw error;
    }
}

/**
 * Waits for the Runtime-ready signal that every spec relies on for readiness.
 *
 * The status bar only renders a _visible_ state chip while Caxri is degraded, so readiness is published as a data
 * attribute that exists in every visual state instead of as display copy.
 */
export function runtimeStatus(page: Page) {
    return page.locator('.statusbar');
}

export async function waitForRuntimeReady(page: Page): Promise<void> {
    await expect(runtimeStatus(page)).toHaveAttribute('data-runtime-status', 'ready');
}

/**
 * Launches Caxri and waits for the Runtime to report ready.
 */
export async function launchCaxri(options: LaunchCaxriOptions): Promise<RunningCaxri> {
    const running = await launchCaxriApp(options);
    await waitForRuntimeReady(running.page);
    return running;
}

/**
 * Waits until Project creation has converged across Runtime state and the visible workbench. A dialog closing or a
 * Session card rendering alone is insufficient: hosted runners can expose either before the selected Session and its
 * first durable Terminal are available together.
 */
export async function waitForCreatedSession(
    page: Page,
    previousSessionId?: string,
): Promise<string> {
    let createdSessionId: string | undefined;
    await expect
        .poll(async () => {
            const state = await pageRequest<{
                selectedSessionId?: string;
                sessions: Array<{ id: string }>;
                terminals: Array<{ sessionId: string }>;
            }>(page, 'app.bootstrap');
            const candidate = state.selectedSessionId;
            if (
                !candidate ||
                candidate === previousSessionId ||
                state.sessions.every(({ id }) => id !== candidate) ||
                state.terminals.every(({ sessionId }) => sessionId !== candidate) ||
                (await page.getByRole('dialog').count()) > 0 ||
                (await sessionCard(page, candidate).count()) === 0
            ) {
                return;
            }
            createdSessionId = candidate;
            return candidate;
        })
        .toBeTruthy();
    return createdSessionId!;
}

/**
 * Opens the "Add Project" dialog, picks the requested default Terminal, and returns only after the new Session
 * satisfies {@link waitForCreatedSession}. Specs that also need a writable Shell surface should use
 * {@link createShellSession} instead.
 */
export async function createProjectSession(
    page: Page,
    kind: 'shell' | AgentProvider = 'shell',
): Promise<string> {
    const previous = await pageRequest<{ selectedSessionId?: string }>(page, 'app.bootstrap');
    await openAddProjectDialog(page);
    await expect(page.getByRole('heading', { name: 'Choose the default Terminal' })).toBeVisible();
    await page
        .getByRole('dialog')
        .getByRole('button', {
            name: kind === 'shell' ? 'Shell' : agentProviderCatalog[kind].displayName,
            exact: true,
        })
        .click();
    return waitForCreatedSession(page, previous.selectedSessionId);
}

/**
 * The sidebar hosts no Add Project button; the default `Cmd+O` keybinding is the primary entry point.
 */
export async function openAddProjectDialog(page: Page): Promise<void> {
    await page.keyboard.press('Meta+o');
}

export async function createShellSession(page: Page): Promise<void> {
    await createProjectSession(page, 'shell');
    const terminalInput = page.locator('.xterm-helper-textarea');
    await expect(terminalInput).toBeVisible();
    /**
     * The initial Terminal focus effect is part of creation completing, not caller setup.
     */
    await expect(terminalInput).toBeFocused();
}

export async function createAdditionalShellSession(page: Page): Promise<void> {
    const before = await pageRequest<{
        selectedSessionId?: string;
        terminals: Array<{ id: string }>;
    }>(page, 'app.bootstrap');
    if (!before.selectedSessionId) throw new Error('No Session selected before creation');
    await page
        .locator('.project-heading')
        .filter({ has: page.getByRole('button', { name: /^New Session in / }) })
        .hover();
    await page.getByRole('button', { name: /^New Session in / }).click();
    await expect(page.getByRole('heading', { name: 'Choose the default Terminal' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Shell', exact: true }).click();
    const terminalId = await waitForNewTerminalId(
        page,
        before.terminals.map((terminal) => terminal.id),
    );
    await expect.poll(() => selectedSessionId(page)).not.toBe(before.selectedSessionId);
    await expect(
        page.locator(`.terminal-pane[data-terminal-id="${terminalId}"] .xterm-helper-textarea`),
    ).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
}

export async function typeTerminal(page: Page, command: string): Promise<void> {
    const input = page.locator('.xterm-helper-textarea').last();
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
}

async function terminalTextBounds(page: Page, text: string) {
    return page.locator('.xterm-rows').evaluate((rows, target) => {
        /**
         * Finds the text-node offsets spanning `[targetStart, targetStart + target.length)` within `row`.
         */
        function findTextNodeRange(
            row: Element,
            targetStart: number,
        ):
            | { start: { node: Node; offset: number }; end: { node: Node; offset: number } }
            | undefined {
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            let offset = 0;
            let start: { node: Node; offset: number } | undefined;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const length = node.textContent?.length ?? 0;
                if (!start && targetStart >= offset && targetStart <= offset + length)
                    start = { node, offset: targetStart - offset };
                const targetEnd = targetStart + target.length;
                if (targetEnd >= offset && targetEnd <= offset + length) {
                    return start ? { start, end: { node, offset: targetEnd - offset } } : undefined;
                }
                offset += length;
            }
            return undefined;
        }

        let matched: { x: number; y: number; width: number; height: number } | undefined;
        for (const row of rows.children) {
            const rowText = row.textContent;
            const targetStart = rowText.indexOf(target);
            if (targetStart === -1) continue;
            const found = findTextNodeRange(row, targetStart);
            if (!found) continue;
            const range = document.createRange();
            range.setStart(found.start.node, found.start.offset);
            range.setEnd(found.end.node, found.end.offset);
            const bounds = range.getBoundingClientRect();
            matched = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        }
        return matched ?? null;
    }, text);
}

/**
 * Moves off the target row before waiting for xterm's asynchronous link provider. xterm caches an empty provider result
 * when output replaces a blank row beneath a stationary pointer.
 */
export async function clickTerminalLink(page: Page, text: string): Promise<void> {
    await expect.poll(() => terminalTextBounds(page, text)).not.toBeNull();
    const bounds = await terminalTextBounds(page, text);
    if (!bounds) throw new Error(`Terminal text not found: ${text}`);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    const rows = page.locator('.xterm-rows > div');
    const [firstRow, lastRow] = await Promise.all([
        rows.first().boundingBox(),
        rows.last().boundingBox(),
    ]);
    if (!firstRow || !lastRow) throw new Error('Terminal rows not found');
    const firstY = firstRow.y + firstRow.height / 2;
    const lastY = lastRow.y + lastRow.height / 2;
    const resetRow = Math.abs(y - firstY) > Math.abs(y - lastY) ? firstRow : lastRow;
    await page.mouse.move(resetRow.x + 2, resetRow.y + resetRow.height / 2);
    await expect(page.locator('.xterm-cursor-pointer')).toHaveCount(0);
    await page.mouse.move(x, y);
    await expect(page.locator('.xterm-cursor-pointer')).toBeVisible();
    await page.keyboard.down('Meta');
    try {
        await page.mouse.click(x, y);
    } finally {
        await page.keyboard.up('Meta');
    }
}

export type PageReply<T> =
    { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

/**
 * Calls the preload bridge from inside the page and returns the raw reply envelope. `window.caxri` resolves instead of
 * rejecting because `contextBridge` copies only `message` and `stack` off a thrown error, so the Caxri error code has
 * to travel as data. Use this when a spec asserts a failure; use {@link pageRequest} when it only needs the result.
 */
export function pageReply<T>(
    page: Page,
    method: string,
    parameters?: unknown,
): Promise<PageReply<T>> {
    return page.evaluate(
        ([requestMethod, requestParameters]) =>
            (
                globalThis as unknown as {
                    caxri: { request(method: string, parameters_?: unknown): Promise<unknown> };
                }
            ).caxri.request(requestMethod, requestParameters),
        [method, parameters] as const,
    ) as Promise<PageReply<T>>;
}

export async function pageRequest<T>(page: Page, method: string, parameters?: unknown): Promise<T> {
    const reply = await pageReply<T>(page, method, parameters);
    if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
    return reply.result;
}

export async function selectedSessionId(page: Page): Promise<string> {
    const state = await pageRequest<{ selectedSessionId?: string }>(page, 'app.bootstrap');
    if (!state.selectedSessionId) throw new Error('No Session selected');
    return state.selectedSessionId;
}

export function sessionCard(page: Page, sessionId: string) {
    return page.locator(`.session-card[data-session-id="${sessionId}"]`);
}

/**
 * Reveals a Bottom Panel view and returns its tab. The Bottom Panel is closed at rest, so its tabs are not in the DOM
 * until `Command+J` opens the region; the toggle is idempotent here only because the panel is asserted closed first.
 */
export async function openBottomPanelView(page: Page, name: 'Info' | 'Logs'): Promise<Locator> {
    const tablist = page.getByRole('tablist', { name: 'Bottom Panel' });
    if ((await tablist.count()) === 0) {
        await page.keyboard.press('Meta+j');
        await expect(tablist).toBeVisible();
    }
    const tab = tablist.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    return tab;
}

/**
 * Splits an existing Terminal by exercising the same tab-to-pane drag gesture as a user.
 */
export async function splitTerminalToRight(page: Page, terminalId: string): Promise<void> {
    await expect(page.locator(`.work-tab[data-terminal-id="${terminalId}"]`)).toBeAttached();
    await expect(page.locator('.pane-surface').first()).toBeAttached();
    await page.evaluate((draggedTerminalId) => {
        const source = document.querySelector(
            `.work-tab[data-terminal-id="${CSS.escape(draggedTerminalId)}"]`,
        );
        // The actual drop listeners live on `.pane-surface`, the content area beneath a pane's tab bar, not on the
        // outer `.workbench-pane` box.
        const target = document.querySelector('.pane-surface');
        if (!source || !target) throw new Error('Terminal split drag fixture not found');
        const transfer = new DataTransfer();
        const bounds = target.getBoundingClientRect();
        const options = {
            bubbles: true,
            cancelable: true,
            clientX: bounds.left + bounds.width * 0.9,
            clientY: bounds.top + bounds.height * 0.5,
            dataTransfer: transfer,
        };
        source.dispatchEvent(new DragEvent('dragstart', options));
        target.dispatchEvent(new DragEvent('dragenter', options));
        target.dispatchEvent(new DragEvent('dragover', options));
        target.dispatchEvent(new DragEvent('drop', options));
        source.dispatchEvent(new DragEvent('dragend', options));
    }, terminalId);
}

/**
 * Scrolls the virtualized Settings list to a category or subcategory by clicking its table of contents entry. Rows
 * outside the viewport are not in the DOM at all (virtual rendering), so tests must reveal a section before interacting
 * with its rows.
 */
export async function revealSettingsSection(dialog: Locator, name: string): Promise<void> {
    await dialog
        .getByRole('navigation', { name: 'Settings categories' })
        .getByRole('button', { name, exact: true })
        .click();
}
