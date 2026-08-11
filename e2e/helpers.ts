import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';

import {
    acquireDesktopLease,
    beginDesktopLeaseHandoff,
    releaseDesktopLease,
    transferDesktopLease,
    type DesktopLeaseHandle,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease.ts';
import { assertBuildOutputsFresh } from '../src/shared/node/build-freshness.ts';
import type { AgentProvider } from '../src/shared/agents.ts';
import { registerE2ELaunch } from './error-gate.ts';

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
    'CAXRI_E2E_FAKE_CLAUDE_EXECUTABLE',
    'CAXRI_E2E_FAKE_CODEX_EXECUTABLE',
] as const;

/**
 * Guards against testing stale build output. Focused e2e runs (eg.
 * `bunx playwright test e2e/foo.e2e.ts`) intentionally skip the `bun run build`
 * step for iteration speed, which otherwise lets a spec silently launch a
 * previously built `out/main/index.js` and pass against old code.
 */
async function assertBuildIsFresh(): Promise<void> {
    await assertBuildOutputsFresh({
        inputPaths: buildInputPaths,
        outputPaths: buildOutputPaths,
        watchedDirectoryExtensions: watchedBuildInputExtensions,
        staleMessage: staleBuildMessage,
    });
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
    /** Blocks host Agents by default; fake and real modes require an explicit per-spec choice. */
    agentMode?: E2EAgentMode;
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
        return {
            CAXRI_E2E_AGENT_MODE: 'real',
            CAXRI_E2E_AGENT_PROVIDER: agentMode.provider ?? 'codex',
        };
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
    for (const provider of ['claude', 'codex'] as const) {
        const target = fakeExecutables[provider];
        const executable = join(shellBin, provider);
        await writeFile(
            executable,
            target
                ? `#!/bin/sh\nexec ${shellQuote(target)} "$@"\n`
                : `#!/bin/sh\nprintf 'Caxri E2E blocked ${provider}\\n' >&2\nexit 127\n`,
            'utf8',
        );
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
        CAXRI_E2E_AGENT_MODE: agentMode.mode,
        ...(fakeExecutables.claude
            ? { CAXRI_E2E_FAKE_CLAUDE_EXECUTABLE: fakeExecutables.claude }
            : {}),
        ...(fakeExecutables.codex
            ? { CAXRI_E2E_FAKE_CODEX_EXECUTABLE: fakeExecutables.codex }
            : {}),
    };
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
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
        windowMode = 'hidden',
        agentMode = { mode: 'blocked' },
    } = options;
    const agentEnvironment = await e2eAgentEnvironment(userDataDir, agentMode, env);
    const launchEnvironmentSource: NodeJS.ProcessEnv = {
        ...process.env,
        ...env,
        ...agentEnvironment,
        CAXRI_E2E: '1',
        CAXRI_E2E_WINDOW_MODE: windowMode,
        CAXRI_USER_DATA_DIR: userDataDir,
        CAXRI_TEST_ROOT_PATH: testRootPath,
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
    );
    let releasePromise: Promise<void> | undefined;
    const releaseLease = (): Promise<void> => (releasePromise ??= releaseDesktopLease(lease));
    let app: ElectronApplication;
    try {
        lease = await beginDesktopLeaseHandoff(lease);
        app = await electron.launch({
            ...(executablePath ? { executablePath } : {}),
            args: executablePath ? ['--disable-gpu'] : ['.', '--disable-gpu'],
            cwd: projectRoot,
            env: launchEnvironment,
        });
        registerE2ELaunch(app, userDataDir, releaseLease);
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
 * Opens the "Add Project" dialog, waits for it to render, and picks the
 * given default Terminal kind. This is the shared subset used by every spec
 * that creates a Project; specs that also need the Terminal surface ready
 * (eg. to type into it) should use {@link createShellSession} instead.
 */
export async function createProjectSession(
    page: Page,
    kind: 'shell' | 'claude' | 'codex' = 'shell',
): Promise<void> {
    await openAddProjectDialog(page);
    await expect(page.getByRole('heading', { name: 'Choose the default Terminal' })).toBeVisible();
    await page
        .getByRole('dialog')
        .getByRole('button', {
            name: kind === 'shell' ? 'Shell' : kind === 'claude' ? 'Claude Code' : 'Codex',
            exact: true,
        })
        .click();
    await expect(page.locator('.session-card')).toHaveCount(1);
    /**
     * Base UI retains the closed portal until its exit animation finishes. Waiting here keeps
     * callers from changing media state mid-animation and leaving an overlay that intercepts the
     * next interaction.
     */
    await expect(page.getByRole('dialog')).toHaveCount(0);
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
}

export async function typeTerminal(page: Page, command: string): Promise<void> {
    const input = page.locator('.xterm-helper-textarea').last();
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
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
