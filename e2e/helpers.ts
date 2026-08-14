import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { connectToHost, discoverHostManifest } from '@caxri/cli';

import {
    acquireDesktopLease,
    beginDesktopLeaseHandoff,
    releaseDesktopLease,
    transferDesktopLease,
    type DesktopLeaseHandle,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease.ts';
import { createBuildFreshnessGuard } from '../src/shared/node/build-freshness.ts';
import {
    e2eAgentPolicyEnvironment,
    e2eAgentShellShims,
    e2eFakeExecutableEnvironmentKeys,
} from '../src/shared/node/e2e-agent-policy.ts';
import type { AgentProvider } from '../src/shared/agents.ts';
import { registerE2ELaunch } from './error-gate.ts';
import { resolveE2EWorkerIsolation } from './worker-isolation.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const staleBuildMessage = 'Build output is stale — run "bun run build" before running e2e specs.';
const buildInputPaths = [
    join(projectRoot, 'src'),
    join(projectRoot, 'electron.vite.config.ts'),
    join(projectRoot, 'package.json'),
    join(projectRoot, 'package-lock.json'),
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
] as const;

/**
 * Guards against testing stale build output. The standard focused entrypoint
 * (`bun run --silent check e2e/foo.e2e.ts --e2e`) builds first, while direct Playwright invocations may
 * skip that step and otherwise silently launch a previously built `out/main/index.js`.
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
    /** Electron `userData` directory; callers create this with `mkdtemp`. */
    userDataDir: string;
    /** Project root exposed to the app through `CAXRI_TEST_ROOT_PATH`. */
    testRootPath: string;
    /**
     * Extra environment variables layered over `process.env` and the Caxri
     * E2E defaults below. Agent executables and provider state belong in
     * `agentMode`; use this only for a scenario-specific shell or tool environment.
     */
    env?: NodeJS.ProcessEnv;
    /** Launches a packaged build instead of `.` (used by the startup benchmark). */
    executablePath?: string;
    /** Hidden by default; use visible only for native focus, pointer, or desktop behavior. */
    windowMode?: 'hidden' | 'visible';
    /** Keeps deterministic software rendering by default; WebGL renderer specs opt into GPU. */
    gpuMode?: 'disabled' | 'enabled';
    /** Blocks host Agents by default; fake and real modes require an explicit per-spec choice. */
    agentMode?: E2EAgentMode;
    /** Restart workflows let the next launch inherit the same live Host; the final launch cleans it. */
    preserveHostOnClose?: boolean;
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
    userDataDir: string,
    agentMode: E2EAgentMode,
    sourceEnvironment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
    if (agentMode.mode === 'real') {
        return e2eAgentPolicyEnvironment({
            mode: 'real',
            provider: agentMode.provider ?? 'codex',
        });
    }
    const fixtureRoot = join(userDataDir, 'e2e-agents');
    const home = join(fixtureRoot, 'home');
    const codexState = join(fixtureRoot, 'codex');
    const claudeState = join(fixtureRoot, 'claude');
    const xdg = join(fixtureRoot, 'xdg');
    const isolatedEnvironment: NodeJS.ProcessEnv = {
        HOME: home,
        CODEX_HOME: codexState,
        CODEX_SQLITE_HOME: codexState,
        CLAUDE_CONFIG_DIR: claudeState,
        XDG_CACHE_HOME: join(xdg, 'cache'),
        XDG_CONFIG_HOME: join(xdg, 'config'),
        XDG_DATA_HOME: join(xdg, 'data'),
    };
    await Promise.all([
        mkdir(home, { recursive: true }),
        mkdir(codexState, { recursive: true }),
        mkdir(claudeState, { recursive: true }),
        mkdir(xdg, { recursive: true }),
    ]);

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
    for (const shim of e2eAgentShellShims(fakeExecutables)) {
        const executable = join(shellBin, shim.executable);
        await writeFile(executable, shim.source, 'utf8');
        await chmod(executable, 0o700);
    }
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

async function stopE2EHost(userDataDir: string): Promise<void> {
    let client: Awaited<ReturnType<typeof connectToHost>> | undefined;
    try {
        client = await connectToHost(userDataDir, 2_000);
        await client.request('host.stop', { confirmLivePtys: true });
    } catch (error) {
        if (errorCode(error) !== 'NOT_FOUND' && errorCode(error) !== 'UNAVAILABLE') throw error;
        return;
    } finally {
        client?.close();
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            await discoverHostManifest(userDataDir);
        } catch (error) {
            if (errorCode(error) === 'NOT_FOUND') return;
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for the E2E Host to stop');
}

/** Waits for the asynchronous New Terminal action to become observable through Runtime state. */
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
 * Launches the Caxri Electron app for e2e tests without waiting for the
 * Runtime to become ready. Most specs should use {@link launchCaxri} instead;
 * this lower-level entry point exists for specs (eg. the startup benchmark)
 * that need to measure the readiness wait themselves.
 */
export async function launchCaxriApp(
    options: LaunchCaxriOptions,
): Promise<{ app: ElectronApplication; page: Page }> {
    await assertBuildIsFresh();
    const {
        userDataDir,
        testRootPath,
        env = {},
        executablePath,
        gpuMode = 'disabled',
        windowMode = 'hidden',
        agentMode = { mode: 'blocked' },
        preserveHostOnClose = false,
    } = options;
    const agentEnvironment = await e2eAgentEnvironment(userDataDir, agentMode, env);
    const workerIsolation = resolveE2EWorkerIsolation(process.env);
    const launchEnvironmentSource: NodeJS.ProcessEnv = {
        ...process.env,
        ...env,
        ...agentEnvironment,
        CAXRI_E2E: '1',
        CAXRI_E2E_WINDOW_MODE: windowMode,
        CAXRI_USER_DATA_DIR: userDataDir,
        CAXRI_TEST_ROOT_PATH: testRootPath,
        ...(workerIsolation.workerNamespace
            ? { CAXRI_E2E_WORKER_NAMESPACE: workerIsolation.workerNamespace }
            : {}),
    };
    /** Prevent ambient internal test switches from adding an undeclared fake provider. */
    for (const key of e2eAgentEnvironmentKeys) {
        if (!(key in agentEnvironment)) delete launchEnvironmentSource[key];
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
    try {
        lease = await beginDesktopLeaseHandoff(lease);
        app = await electron.launch({
            ...(executablePath ? { executablePath } : {}),
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
        let cleanupPromise: Promise<void> | undefined;
        const cleanup = (): Promise<void> =>
            (cleanupPromise ??= (async () => {
                if (!preserveHostOnClose) await stopE2EHost(userDataDir);
                await releaseLease();
            })());
        const close = app.close.bind(app);
        Object.defineProperty(app, 'close', {
            configurable: true,
            value: async () => {
                await close();
                await cleanup();
            },
        });
        registerE2ELaunch(app, userDataDir, cleanup);
        const electronPid = app.process().pid;
        if (!electronPid) throw new Error('Could not establish the Electron process identity');
        lease = await transferDesktopLease(lease, electronPid);
    } catch (error) {
        await releaseLease();
        throw error;
    }
    try {
        const page = await app.firstWindow();
        return { app, page };
    } catch (error) {
        await app.close().catch(() => undefined);
        await releaseLease().catch(() => undefined);
        throw error;
    }
}

/**
 * Waits for the Runtime-ready signal that every spec relies on for readiness.
 *
 * The status bar only renders a *visible* state chip while Caxri is degraded, so readiness is
 * published as a data attribute that exists in every visual state instead of as display copy.
 */
export function runtimeStatus(page: Page) {
    return page.locator('.statusbar');
}

export async function waitForRuntimeReady(page: Page): Promise<void> {
    await expect(runtimeStatus(page)).toHaveAttribute('data-runtime-status', 'ready');
}

/** Launches Caxri and waits for the Runtime to report ready. */
export async function launchCaxri(
    options: LaunchCaxriOptions,
): Promise<{ app: ElectronApplication; page: Page }> {
    const running = await launchCaxriApp(options);
    await waitForRuntimeReady(running.page);
    return running;
}

/**
 * Waits until Project creation has converged across Runtime state and the visible workbench.
 * A dialog closing or a Session card rendering alone is insufficient: hosted runners can expose
 * either before the selected Session and its first durable Terminal are available together.
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
                !state.sessions.some(({ id }) => id === candidate) ||
                !state.terminals.some(({ sessionId }) => sessionId === candidate) ||
                (await page.getByRole('dialog').count()) > 0 ||
                (await sessionCard(page, candidate).count()) === 0
            ) {
                return undefined;
            }
            createdSessionId = candidate;
            return candidate;
        })
        .toBeTruthy();
    return createdSessionId!;
}

/**
 * Opens the "Add Project" dialog, picks the requested default Terminal, and returns only after
 * the new Session satisfies {@link waitForCreatedSession}. Specs that also need a writable Shell
 * surface should use {@link createShellSession} instead.
 */
export async function createProjectSession(
    page: Page,
    kind: 'shell' | 'claude' | 'codex' = 'shell',
): Promise<string> {
    const previous = await pageRequest<{ selectedSessionId?: string }>(page, 'app.bootstrap');
    await openAddProjectDialog(page);
    await expect(page.getByRole('heading', { name: 'Choose the default Terminal' })).toBeVisible();
    await page
        .getByRole('dialog')
        .getByRole('button', {
            name: kind === 'shell' ? 'Shell' : kind === 'claude' ? 'Claude Code' : 'Codex',
            exact: true,
        })
        .click();
    return waitForCreatedSession(page, previous.selectedSessionId);
}

/** Reveals the quiet titlebar action before activating it, matching pointer use at rest. */
export async function openAddProjectDialog(page: Page): Promise<void> {
    const titlebar = page.locator('.sidebar-title');
    await titlebar.hover({ position: { x: 90, y: 22 } });
    await titlebar.getByRole('button', { name: 'Add Project', exact: true }).click();
}

export async function createShellSession(page: Page): Promise<void> {
    await createProjectSession(page, 'shell');
    const terminalInput = page.locator('.xterm-helper-textarea');
    await expect(terminalInput).toBeVisible();
    /** The initial Terminal focus effect is part of creation completing, not caller setup. */
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
        let matched: { x: number; y: number; width: number; height: number } | undefined;
        for (const row of rows.children) {
            const rowText = row.textContent ?? '';
            const targetStart = rowText.indexOf(target);
            if (targetStart < 0) continue;
            const range = document.createRange();
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            let offset = 0;
            let start: { node: Node; offset: number } | undefined;
            let end: { node: Node; offset: number } | undefined;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const length = node.textContent?.length ?? 0;
                if (!start && targetStart >= offset && targetStart <= offset + length)
                    start = { node, offset: targetStart - offset };
                const targetEnd = targetStart + target.length;
                if (targetEnd >= offset && targetEnd <= offset + length) {
                    end = { node, offset: targetEnd - offset };
                    break;
                }
                offset += length;
            }
            if (!start || !end) continue;
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            const bounds = range.getBoundingClientRect();
            matched = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        }
        return matched ?? null;
    }, text);
}

/**
 * Moves off the target row before waiting for xterm's asynchronous link provider. xterm caches
 * an empty provider result when output replaces a blank row beneath a stationary pointer.
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
 * Calls the preload bridge from inside the page and returns the raw reply envelope. `window.caxri`
 * resolves instead of rejecting because `contextBridge` copies only `message` and `stack` off a
 * thrown error, so the Caxri error code has to travel as data. Use this when a spec asserts a
 * failure; use {@link pageRequest} when it only needs the result.
 */
export function pageReply<T>(page: Page, method: string, params?: unknown): Promise<PageReply<T>> {
    return page.evaluate(
        ([requestMethod, requestParams]) =>
            (
                window as unknown as {
                    caxri: { request(method: string, params?: unknown): Promise<unknown> };
                }
            ).caxri.request(requestMethod, requestParams),
        [method, params] as const,
    ) as Promise<PageReply<T>>;
}

export async function pageRequest<T>(page: Page, method: string, params?: unknown): Promise<T> {
    const reply = await pageReply<T>(page, method, params);
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

/** Splits an existing Terminal by exercising the same tab-to-pane drag gesture as a user. */
export async function splitTerminalToRight(page: Page, terminalId: string): Promise<void> {
    await expect(page.locator(`.work-tab[data-terminal-id="${terminalId}"]`)).toBeAttached();
    await expect(page.locator('.terminal-group').first()).toBeAttached();
    await page.evaluate((draggedTerminalId) => {
        const source = document.querySelector(`.work-tab[data-terminal-id="${draggedTerminalId}"]`);
        const target = document.querySelector('.terminal-group');
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
