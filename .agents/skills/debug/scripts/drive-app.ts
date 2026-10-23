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
 * - `open-chat <claude|codex|grok>`: adds the fixture's test-root Project (`Cmd+O`) and opens that Agent in Chat.
 * - `send <text>`: types into the visible Agent Chat message box and presses Enter.
 * - `paste-image [count]`: pastes that many synthetic PNGs (default 1) into the visible Agent Chat message box, as a
 *   screenshot paste would, without touching the system clipboard.
 * - `search <query>`: opens Session search and types the query.
 * - `idle [seconds]`: waits until the window's text stops changing, such as after an Agent reply.
 * - `ready [seconds]`: waits until a dev instance just started with `switch-worktree dev` answers over CDP as this
 *   worktree's window, instead of a fixed sleep.
 * - `select-session <id prefix|title>`: clicks that Session in the sidebar, as a user opening it would.
 * - `stub-folder-dialog <absolute path>`: makes Main's native folder picker return that path. Needs the dev instance
 *   started with `V8_INSPECTOR_PORT=<port>` exported; pass the same port as `--inspector-port` or in that variable.
 * - `screenshot <absolute path>`.
 */
import { isAbsolute } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import type { Browser, Page } from '@playwright/test';
import { chromium } from '@playwright/test';

import { CommandError } from '../../switch-worktree/scripts/process';
import type { CdpTarget } from './cdp-client';
import { connectToNodeInspector, selectRendererTarget } from './cdp-client';
import { browserEnvironment, resolveTarget } from './worktree-browser';

const STEPS = [
    'language',
    'open-chat',
    'send',
    'paste-image',
    'search',
    'idle',
    'ready',
    'select-session',
    'stub-folder-dialog',
    'screenshot',
] as const;
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
const DEFAULT_READY_SECONDS = 120;
/**
 * How long one `Cmd+O` gets to show the add-Project dialog, and how many presses `open-chat` makes.
 */
const OPEN_DIALOG_ATTEMPT_MS = 5_000;
const OPEN_DIALOG_ATTEMPTS = 3;
const OPEN_CHAT_TIMEOUT_MS = 30_000;

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
    const isArgumentRequired = step !== 'idle' && step !== 'ready' && step !== 'paste-image';
    if (isArgumentRequired && !argument) throw new CommandError(`\`${step}\` needs an argument`, 2);
    if (step === 'open-chat' && !Object.hasOwn(agentProviderCatalog, argument)) {
        throw new CommandError(
            `\`open-chat\` takes ${Object.keys(agentProviderCatalog).join(', ')}, not ${argument}`,
            2,
        );
    }
    if (argument && (step === 'idle' || step === 'ready') && !(Number(argument) > 0)) {
        throw new CommandError(`\`${step}\` takes a number of seconds, not ${argument}`, 2);
    }
    if (argument && step === 'paste-image' && !Number.isSafeInteger(Number(argument))) {
        throw new CommandError(`\`paste-image\` takes a count, not ${argument}`, 2);
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

/**
 * The add-Project dialog's row for an Agent opened in Chat (`Codex Chat`, `Codex 对话`). It matches either interface
 * language, because a fresh fixture profile follows the macOS language and an English-only name never appears there.
 * The markers are `terminal.new.chatMarker` in the en and zh-cn Renderer locales, which this script's TypeScript
 * project cannot import.
 */
export function chatChoiceName(provider: AgentProvider): RegExp {
    const name = RegExp.escape(agentProviderCatalog[provider].displayName);
    return new RegExp(String.raw`^${name}\s*(?:Chat|对话)$`);
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

/**
 * Pastes gradient PNGs the way `e2e/agent-chat-input.e2e.ts` does: a `paste` event carrying files, so the system
 * clipboard the user may be holding stays untouched. Each image gets its own hue and name so several stay apart.
 */
async function pasteImages(page: Page, count: number): Promise<void> {
    const message = page.locator('.cm-content').filter({ visible: true }).last();
    await message.evaluate(async (element, total) => {
        const draw = async (index: number): Promise<File> => {
            const canvas = new OffscreenCanvas(320, 200);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('2D canvas unavailable');
            const gradient = context.createLinearGradient(0, 0, 320, 200);
            gradient.addColorStop(0, `hsl(${(index * 70 + 210) % 360} 80% 55%)`);
            gradient.addColorStop(1, `hsl(${(index * 70 + 20) % 360} 90% 55%)`);
            context.fillStyle = gradient;
            context.fillRect(0, 0, 320, 200);
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            return new File([blob], `pasted-${index + 1}.png`, { type: 'image/png' });
        };
        const files = await Promise.all(Array.from({ length: total }, (_, index) => draw(index)));
        const clipboardData = new DataTransfer();
        for (const file of files) clipboardData.items.add(file);
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
    }, count);
}

/**
 * Runs the add-Project dialog in one go. The test-root selection behind `Cmd+O` expires while the dialog waits, and an
 * expired one fails `project.create` with `PATH_DENIED` and creates nothing, so a slow hand-driven choice silently
 * leaves the app without a Session.
 */
async function openChat(page: Page, provider: AgentProvider): Promise<void> {
    const before = await request<{ selectedSessionId?: string }>(page, 'app.bootstrap');
    // A CDP connection does not focus the window, and the shortcut only reaches a focused document.
    await page.bringToFront();
    const dialog = page.getByRole('dialog');
    const inChat = dialog.getByRole('switch');
    // Right after launch the window can drop the first `Cmd+O` (the shortcut registers after the first paint), so a
    // dialog that does not show presses it again rather than failing the whole step.
    for (let attempt = 1; ; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- each press waits to see whether the previous one landed.
        await page.keyboard.press('Meta+o');
        try {
            // eslint-disable-next-line no-await-in-loop
            await inChat.waitFor({ timeout: OPEN_DIALOG_ATTEMPT_MS });
            break;
        } catch (error) {
            if (attempt >= OPEN_DIALOG_ATTEMPTS) throw error;
        }
    }
    if ((await inChat.getAttribute('aria-checked')) !== 'true') await inChat.click();
    // The provider row gains its Chat badge once the setting lands; choosing earlier opens a Terminal.
    const choice = dialog.getByRole('button', { name: chatChoiceName(provider) });
    await choice.waitFor();
    // Choosing closes the dialog synchronously, so Enter avoids a pointer click observing its target detach.
    await choice.focus();
    await choice.press('Enter');
    const deadline = Date.now() + OPEN_CHAT_TIMEOUT_MS;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const state = await request<{ selectedSessionId?: string }>(page, 'app.bootstrap');
        if (state.selectedSessionId && state.selectedSessionId !== before.selectedSessionId) break;
        if (Date.now() > deadline) {
            throw new Error(
                'No Session was created; check the structured logs for a failed project.create',
            );
        }
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(IDLE_POLL_MS);
    }
    await page
        .locator('.cm-content')
        .filter({ visible: true })
        .last()
        .waitFor({ timeout: OPEN_CHAT_TIMEOUT_MS });
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
        case 'open-chat':
            return openChat(page, argument as AgentProvider);
        case 'send': {
            // The message box is CodeMirror, which exposes no textbox role to fill.
            await page.locator('.cm-content').filter({ visible: true }).last().click();
            await page.keyboard.type(argument);
            await page.keyboard.press('Enter');
            return;
        }
        case 'paste-image':
            return pasteImages(page, argument ? Number(argument) : 1);
        case 'search': {
            await page.keyboard.press('Meta+Shift+S');
            // Matched by role alone so the step works in either interface language.
            await page.getByRole('dialog').getByRole('combobox').first().fill(argument);
            return;
        }
        case 'idle':
            return waitForIdle(page, argument ? Number(argument) : DEFAULT_IDLE_SECONDS);
        case 'ready':
            // `main` only reaches a step once the window answered, which is all `ready` waits for.
            return;
        case 'select-session': {
            const rows = page.locator('[data-session-id]');
            // A window that just became ready may not have drawn the sidebar's Sessions yet.
            await rows.first().waitFor();
            const byId = rows.and(page.locator(`[data-session-id^=${JSON.stringify(argument)}]`));
            const row = (await byId.count()) > 0 ? byId : rows.filter({ hasText: argument });
            await row.first().click();
            return;
        }
        case 'screenshot':
            await page.screenshot({ path: argument });
            return;
        case 'stub-folder-dialog':
            return stubFolderDialog(command.inspectorPort!, argument);
    }
}

async function connect(root: string, cdpPort: number): Promise<{ browser: Browser; page: Page }> {
    const targets = (await (
        await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
    ).json()) as CdpTarget[];
    const rendererUrl = selectRendererTarget(targets).url;
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
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
                `CDP port ${cdpPort} answered for ${reached ?? 'an unknown window'}, not ${root}`,
            );
        }
        return { browser, page };
    } catch (error) {
        await browser.close();
        throw error;
    }
}

/**
 * `ready` retries everything up to the window answering: the launcher records the dev process and its port before
 * Electron opens a window, and the window loads the Renderer after that.
 */
async function connectWhenReady(
    cwd: string,
    seconds: number,
): Promise<{ browser: Browser; page: Page }> {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
        try {
            // eslint-disable-next-line no-await-in-loop -- each attempt waits to see whether the window is up yet.
            const { root, target } = await resolveTarget(cwd);
            // eslint-disable-next-line no-await-in-loop
            return await connect(root, target.cdpPort);
        } catch (error) {
            if (Date.now() > deadline) throw error;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
    }
}

async function main(): Promise<void> {
    const command = parseDriveCommand(process.argv.slice(2));
    // Main is reached through its own inspector; the window may not even be open yet.
    if (command.step === 'stub-folder-dialog') {
        await stubFolderDialog(command.inspectorPort!, command.argument!);
        return;
    }
    // Playwright's CDP connection would also follow a proxy for a loopback address.
    const environment = browserEnvironment(process.env);
    for (const name of Object.keys(process.env))
        if (!(name in environment)) delete process.env[name];
    let connection: { browser: Browser; page: Page };
    if (command.step === 'ready') {
        connection = await connectWhenReady(
            process.cwd(),
            command.argument ? Number(command.argument) : DEFAULT_READY_SECONDS,
        );
    } else {
        const { root, target } = await resolveTarget(process.cwd());
        connection = await connect(root, target.cdpPort);
    }
    const { browser, page } = connection;
    try {
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
