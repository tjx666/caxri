import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';

const projectRoot = resolve(import.meta.dirname, '..');
const mainEntryPath = join(projectRoot, 'out', 'main', 'index.js');
const watchedSourceExtensions = new Set(['.ts', '.tsx', '.css', '.html']);

/**
 * Recursively finds the newest mtime among watched source files under `directory`.
 * Returns `0` when the directory has no matching files (or does not exist).
 */
async function newestSourceMtimeMs(directory: string): Promise<number> {
    let entries: Dirent[];
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        return 0;
    }

    let newest = 0;
    for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            newest = Math.max(newest, await newestSourceMtimeMs(entryPath));
        } else if (watchedSourceExtensions.has(extname(entry.name))) {
            const { mtimeMs } = await stat(entryPath);
            newest = Math.max(newest, mtimeMs);
        }
    }
    return newest;
}

/**
 * Guards against testing stale build output. Focused e2e runs (eg.
 * `bunx playwright test e2e/foo.e2e.ts`) intentionally skip the `bun run build`
 * step for iteration speed, which otherwise lets a spec silently launch a
 * previously built `out/main/index.js` and pass against old code.
 */
async function assertBuildIsFresh(): Promise<void> {
    let outMtimeMs: number;
    try {
        outMtimeMs = (await stat(mainEntryPath)).mtimeMs;
    } catch {
        throw new Error('Build output is stale — run "bun run build" before running e2e specs.');
    }

    const sourceMtimeMs = await newestSourceMtimeMs(join(projectRoot, 'src'));
    if (sourceMtimeMs > outMtimeMs) {
        throw new Error('Build output is stale — run "bun run build" before running e2e specs.');
    }
}

export interface LaunchCaxriOptions {
    /** Electron `userData` directory; callers create this with `mkdtemp`. */
    userDataDir: string;
    /** Project root exposed to the app through `CAXRI_TEST_ROOT_PATH`. */
    testRootPath: string;
    /**
     * Extra environment variables layered over `process.env` and the Caxri
     * E2E defaults below. Use this to prepend `PATH` with fake agent CLIs,
     * set `CODEX_SQLITE_HOME`, or force a missing `SHELL`/`PATH` scenario.
     */
    env?: NodeJS.ProcessEnv;
    /** Launches a packaged build instead of `.` (used by the startup benchmark). */
    executablePath?: string;
}

/**
 * Launches the Caxri Electron app for e2e tests without waiting for the
 * Runtime to become ready. Most specs should use {@link launchCaxri} instead;
 * this lower-level entry point exists for specs (eg. the startup benchmark)
 * that need to measure the "Runtime ready" wait themselves.
 */
export async function launchCaxriApp(
    options: LaunchCaxriOptions,
): Promise<{ app: ElectronApplication; page: Page }> {
    await assertBuildIsFresh();
    const { userDataDir, testRootPath, env = {}, executablePath } = options;

    const app = await electron.launch({
        ...(executablePath ? { executablePath } : {}),
        args: executablePath ? ['--disable-gpu'] : ['.', '--disable-gpu'],
        cwd: projectRoot,
        env: {
            ...process.env,
            ...env,
            CAXRI_E2E: '1',
            CAXRI_USER_DATA_DIR: userDataDir,
            CAXRI_TEST_ROOT_PATH: testRootPath,
        },
    });
    const page = await app.firstWindow();
    return { app, page };
}

/** Waits for the Runtime-ready signal that every spec relies on for readiness. */
export async function waitForRuntimeReady(page: Page): Promise<void> {
    await expect(page.getByText('Runtime ready')).toBeVisible();
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
    kind: 'shell' | 'codex' = 'shell',
): Promise<void> {
    await page.getByRole('button', { name: 'Add Project', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'Choose the default Terminal' })).toBeVisible();
    await page
        .getByRole('dialog')
        .getByRole('button', { name: kind === 'shell' ? 'Shell' : 'Codex', exact: true })
        .click();
    await expect(page.locator('.session-card')).toHaveCount(1);
}

export async function createShellSession(page: Page): Promise<void> {
    await createProjectSession(page, 'shell');
    await expect(page.locator('.xterm-helper-textarea')).toBeVisible();
}

export async function createAdditionalShellSession(page: Page): Promise<void> {
    await page.getByRole('button', { name: /^New Session in / }).click();
    await expect(page.getByRole('heading', { name: 'Choose the default Terminal' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Shell', exact: true }).click();
}

export async function typeTerminal(page: Page, command: string): Promise<void> {
    const input = page.locator('.xterm-helper-textarea').last();
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
}

export async function selectedSessionId(page: Page): Promise<string> {
    return page.evaluate(async () => {
        const bridge = (
            window as unknown as {
                caxri: {
                    request<T>(method: string, params?: unknown): Promise<T>;
                };
            }
        ).caxri;
        const state = await bridge.request<{ selectedSessionId?: string }>('app.bootstrap');
        if (!state.selectedSessionId) throw new Error('No Session selected');
        return state.selectedSessionId;
    });
}

export function sessionCard(page: Page, sessionId: string) {
    return page.locator(`.session-card[data-session-id="${sessionId}"]`);
}
