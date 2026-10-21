/**
 * Drives this worktree's running dev instance through the Caxri-specific steps a manual verification keeps repeating,
 * so an agent does not hand-roll a Playwright script for each one. Each invocation runs one step against the window
 * `worktree-browser.ts` would reach (same recorded port, same `__caxriWorktree` check) and can capture a screenshot
 * after it. Generic clicks, snapshots, and key presses stay with `worktree-browser.ts`.
 *
 * Usage: `bun run .agents/skills/debug/scripts/drive-app.ts <step> [argument] [--screenshot <absolute path>]`
 *
 * Steps:
 *
 * - `language <en|zh-CN|system>`: sets `workbench.language`, so English-label E2E helpers match.
 * - `send <text>`: types into the visible Agent Chat message box and presses Enter.
 * - `search <query>`: opens Session search and types the query.
 * - `idle [seconds]`: waits until the window's text stops changing, such as after an Agent reply.
 * - `stub-folder-dialog <absolute path>`: makes Main's native folder picker return that path. Needs the dev instance
 *   started with `V8_INSPECTOR_PORT=<port>` exported; pass the same port as `--inspector-port` or in that variable.
 * - `screenshot <absolute path>`.
 */
import { isAbsolute } from 'node:path';
import process from 'node:process';

import type { Page } from '@playwright/test';
import { chromium } from '@playwright/test';

import { CommandError } from '../../switch-worktree/scripts/process';
import type { CdpTarget } from './cdp-client';
import { connectToNodeInspector, selectRendererTarget } from './cdp-client';
import { browserEnvironment, resolveTarget } from './worktree-browser';

const STEPS = ['language', 'send', 'search', 'idle', 'stub-folder-dialog', 'screenshot'] as const;
type Step = (typeof STEPS)[number];

export interface DriveCommand {
    step: Step;
    argument?: string;
    screenshot?: string;
    inspectorPort?: number;
}

const IDLE_POLL_MS = 1_000;
/**
 * Consecutive unchanged polls that count as idle: a streaming reply can pause for a second between chunks.
 */
const IDLE_STABLE_POLLS = 3;
const DEFAULT_IDLE_SECONDS = 120;

export function parseDriveCommand(
    argv: string[],
    environment: NodeJS.ProcessEnv = process.env,
): DriveCommand {
    const positional: string[] = [];
    let screenshot: string | undefined;
    let inspectorPort = environment.V8_INSPECTOR_PORT;
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (value === '--screenshot') screenshot = argv[++index];
        else if (value === '--inspector-port') inspectorPort = argv[++index];
        else positional.push(value);
    }
    const [step, argument, ...rest]: Array<string | undefined> = positional;
    if (!STEPS.includes(step as Step)) {
        throw new CommandError(`Pass a step: ${STEPS.join(', ')}`, 2);
    }
    if (rest.length > 0) {
        throw new CommandError('Quote a multi-word argument as one shell word', 2);
    }
    const isArgumentRequired = step !== 'idle';
    if (isArgumentRequired && !argument) throw new CommandError(`\`${step}\` needs an argument`, 2);
    if (step === 'idle' && argument && !(Number(argument) > 0)) {
        throw new CommandError(`\`idle\` takes a number of seconds, not ${argument}`, 2);
    }
    for (const path of [screenshot, step === 'screenshot' ? argument : undefined]) {
        // The page saves relative to the launcher's directory, which may be another checkout.
        if (path !== undefined && !isAbsolute(path)) {
            throw new CommandError(`Screenshot path must be absolute: ${path}`, 2);
        }
    }
    const port = inspectorPort ? Number(inspectorPort) : undefined;
    if (step === 'stub-folder-dialog' && !Number.isSafeInteger(port)) {
        throw new CommandError(
            'Start the dev instance with V8_INSPECTOR_PORT exported and pass --inspector-port',
            2,
        );
    }
    return { step: step as Step, argument, screenshot, inspectorPort: port };
}

/**
 * `settings.update` replaces the whole settings source rather than patching one key, so the language goes into the
 * current values. `system` clears the override, which follows the macOS language.
 */
export function settingsSourceWithLanguage(
    settings: Record<string, unknown>,
    language: string,
): string {
    if (!['en', 'zh-CN', 'system'].includes(language)) {
        throw new CommandError(`Language must be en, zh-CN, or system, not ${language}`, 2);
    }
    return JSON.stringify(
        { ...settings, 'workbench.language': language === 'system' ? null : language },
        null,
        4,
    );
}

async function request<T>(page: Page, method: string, parameters?: unknown): Promise<T> {
    const reply = (await page.evaluate(
        ([requestMethod, requestParameters]) =>
            (
                globalThis as unknown as {
                    caxri: { request(method: string, parameters_?: unknown): Promise<unknown> };
                }
            ).caxri.request(requestMethod, requestParameters),
        [method, parameters] as const,
    )) as { ok: true; result: T } | { ok: false; error: { code: string; message: string } };
    if (!reply.ok) throw new Error(`${method} failed: ${reply.error.code}: ${reply.error.message}`);
    return reply.result;
}

async function waitForIdle(page: Page, seconds: number): Promise<void> {
    const deadline = Date.now() + seconds * 1_000;
    let previous: string | null = '';
    let stable = 0;
    while (stable < IDLE_STABLE_POLLS) {
        if (Date.now() > deadline) throw new Error(`Window text still changing after ${seconds}s`);
        // Each poll compares against the previous one, so the waits are sequential by design.
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(IDLE_POLL_MS);
        // eslint-disable-next-line no-await-in-loop
        const text = await page.locator('body').textContent();
        stable = text === previous ? stable + 1 : 0;
        previous = text;
    }
}

/**
 * Main has no page target, so the stub goes through its Node inspector. `includeCommandLineAPI` exposes `require`
 * there, as `e2e/support/packaged-project-dialog.ts` gets `dialog` through Playwright's Electron handle.
 */
async function stubFolderDialog(inspectorPort: number, folder: string): Promise<void> {
    const connection = await connectToNodeInspector(inspectorPort);
    try {
        const expression = `(() => {
            const { dialog } = require('electron');
            dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [${JSON.stringify(folder)}] });
            return 'stubbed';
        })()`;
        const result = await connection.request<{ exceptionDetails?: { text: string } }>(
            'Runtime.evaluate',
            { expression, includeCommandLineAPI: true },
        );
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    } finally {
        connection.close();
    }
}

async function runStep(page: Page, command: DriveCommand): Promise<void> {
    const argument = command.argument ?? '';
    switch (command.step) {
        case 'language': {
            const settings = await request<{ value: Record<string, unknown> }>(
                page,
                'settings.get',
            );
            await request(page, 'settings.update', {
                source: settingsSourceWithLanguage(settings.value, argument),
            });
            return;
        }
        case 'send': {
            // The message box is CodeMirror, which exposes no textbox role to fill.
            await page.locator('.cm-content').filter({ visible: true }).last().click();
            await page.keyboard.type(argument);
            await page.keyboard.press('Enter');
            return;
        }
        case 'search': {
            await page.keyboard.press('Meta+Shift+S');
            // Matched by role alone so the step works in either interface language.
            await page.getByRole('dialog').getByRole('combobox').first().fill(argument);
            return;
        }
        case 'idle':
            return waitForIdle(page, argument ? Number(argument) : DEFAULT_IDLE_SECONDS);
        case 'screenshot':
            await page.screenshot({ path: argument });
            return;
        case 'stub-folder-dialog':
            return stubFolderDialog(command.inspectorPort!, argument);
    }
}

async function main(): Promise<void> {
    const command = parseDriveCommand(process.argv.slice(2));
    // Main is reached through its own inspector; the window may not even be open yet.
    if (command.step === 'stub-folder-dialog') {
        await stubFolderDialog(command.inspectorPort!, command.argument!);
        return;
    }
    const { root, target } = await resolveTarget(process.cwd());
    // Playwright's CDP connection would also follow a proxy for a loopback address.
    const environment = browserEnvironment(process.env);
    for (const name of Object.keys(process.env))
        if (!(name in environment)) delete process.env[name];
    const targets = (await (
        await fetch(`http://127.0.0.1:${target.cdpPort}/json/list`)
    ).json()) as CdpTarget[];
    const rendererUrl = selectRendererTarget(targets).url;
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${target.cdpPort}`);
    try {
        const page = browser
            .contexts()
            .flatMap((context) => context.pages())
            .find((candidate) => candidate.url() === rendererUrl);
        if (!page) throw new Error(`No page for ${rendererUrl}`);
        const reached = await page.evaluate(
            () => (globalThis as { __caxriWorktree?: string }).__caxriWorktree,
        );
        if (reached !== root) {
            throw new CommandError(
                `CDP port ${target.cdpPort} answered for ${reached ?? 'an unknown window'}, not ${root}`,
            );
        }
        await runStep(page, command);
        if (command.screenshot) await page.screenshot({ path: command.screenshot });
    } finally {
        // Closing a CDP-connected browser detaches without quitting the app.
        await browser.close();
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = error instanceof CommandError ? error.exitCode : 1;
    }
}
