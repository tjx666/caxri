import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BotSnapshot } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import type { RunningCaxri } from './support/helpers.ts';
import {
    closeAppQuietly,
    createShellSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';

async function openBotWindow({ app, page: workbench }: RunningCaxri): Promise<Page> {
    await pageRequest(workbench, 'caxriBot.open');
    await expect.poll(() => app.windows().length).toBe(2);
    const bot = app.windows().find((page) => page !== workbench)!;
    await expect(bot.locator('.terminal-pane .terminal-surface')).toHaveAttribute(
        'data-terminal-attached',
        'true',
    );
    return bot;
}

/**
 * The native menu owns `Cmd+Shift+P`, so the Caxri Bot window only gets its palette when Main forwards the accelerator
 * to it instead of raising the Workbench palette behind it. The More menu offers the same palette for pointer users.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot opens its own command palette from Cmd+Shift+P and the More menu', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-palette-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const bot = await openBotWindow(running);
        const inboxToggle = bot.getByRole('button', { name: /^Needs you/u });
        const wasInboxVisible = (await inboxToggle.getAttribute('aria-pressed')) === 'true';

        /**
         * Electron hands a menu item's click the focused window; passing Caxri Bot's reproduces its accelerator without
         * depending on which app macOS has in front during the run.
         */
        await running.app.evaluate(({ BrowserWindow, Menu }) => {
            const window = BrowserWindow.getAllWindows().find((candidate) =>
                candidate.webContents.getURL().includes('caxri-bot.html'),
            );
            const item = Menu.getApplicationMenu()?.getMenuItemById('command.commandPalette.open');
            if (!window || !item) throw new Error('Caxri Bot window or Command Palette is missing');
            (item.click as (...parameters: unknown[]) => void)(
                { triggeredByAccelerator: true },
                window,
                window.webContents,
            );
        });
        const input = bot.getByPlaceholder('Type a command or a Session');
        await expect(input).toBeFocused();
        await expect(running.page.getByRole('dialog')).toHaveCount(0);
        await testInfo.attach('bot-palette', {
            body: await bot.screenshot(),
            contentType: 'image/png',
        });

        await input.fill('needs you');
        const toggleRow = wasInboxVisible ? 'Hide Needs you' : 'Show Needs you';
        await bot.getByRole('option', { name: toggleRow }).click();
        await expect(input).toHaveCount(0);
        await expect(inboxToggle).toHaveAttribute('aria-pressed', String(!wasInboxVisible));

        await bot.getByRole('button', { name: 'More', exact: true }).click();
        await bot.getByRole('menuitem', { name: /^Command Palette…/u }).click();
        await expect(input).toBeFocused();
        await bot.keyboard.press('Escape');
        await expect(input).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * Clear Caxri Bot Data is destructive, so Main asks the native confirmation first. A cancel there keeps the dialog and
 * its selection; a confirm clears exactly what was ticked and names it.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Clear Caxri Bot Data clears what was ticked after the native confirmation', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-clear-data-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'bot.inbox.add', {
            kind: 'decision',
            title: 'Which database should the import use?',
        });
        await pageRequest(running.page, 'bot.inbox.add', {
            kind: 'decision',
            title: 'Approve the release?',
        });
        const chip = running.page.locator('.bot-inbox-chip');
        await expect(chip).toHaveText('2 need you');
        const bot = await openBotWindow(running);

        // Answers Cancel first, then Clear Data, and keeps each prompt's detail for the assertions below.
        await running.app.evaluate(({ dialog }) => {
            const responses = [1, 0];
            const shown: string[] = [];
            Reflect.set(globalThis, '__clearDataPrompts', shown);
            dialog.showMessageBox = ((_window: unknown, options: { detail?: string }) => {
                shown.push(options.detail ?? '');
                return Promise.resolve({
                    response: responses.shift() ?? 1,
                    checkboxChecked: false,
                });
            }) as typeof dialog.showMessageBox;
        });
        const prompts = () =>
            running.app.evaluate(
                () => (Reflect.get(globalThis, '__clearDataPrompts') as string[] | undefined) ?? [],
            );

        await bot.getByRole('button', { name: 'More', exact: true }).click();
        await bot.getByRole('menuitem', { name: 'Clear Caxri Bot Data…' }).click();
        const dialog = bot.locator('.bot-clear-data-dialog');
        const inbox = dialog.locator('[data-clear-data="inbox"]');
        await expect(inbox).toContainText('2 open · 0 closed');
        // Nothing is ticked by default when the task ledger is empty, so the dialog cannot clear anything yet.
        const submit = dialog.getByRole('button', { name: 'Clear Data', exact: true });
        await expect(submit).toBeDisabled();
        await inbox.getByRole('checkbox').click();
        await testInfo.attach('bot-clear-data', {
            body: await bot.screenshot(),
            contentType: 'image/png',
        });

        await submit.click();
        await expect.poll(prompts).toHaveLength(1);
        await expect(inbox).toHaveAttribute('data-checked', 'true');
        await expect(chip).toHaveText('2 need you');

        await submit.click();
        await expect(dialog).toHaveCount(0);
        await expect(bot.getByText('Cleared 2 Needs you items')).toBeVisible();
        await expect(chip).toHaveCount(0);
        expect(await prompts()).toEqual([
            expect.stringMatching(/^• Every Needs you item and reply\n/u),
            expect.stringMatching(/^• Every Needs you item and reply\n/u),
        ]);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * Switching Caxri Bot's Agent keeps its Terminal, so every task it delegated stays its own. Claude Code would stop at
 * its folder-trust dialog in the Caxri Bot workspace, so the switch must pre-grant that trust in Claude's config.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot switches to Claude in place, with its workspace already trusted', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-switch-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {}, claude: {} },
    });
    /**
     * Trust is granted only in a config Claude Code already wrote: a Claude Code that never ran shows its onboarding
     * anyway, and its first run must not find a file Caxri invented.
     */
    const claudeConfig = join(agentMode.environment.CLAUDE_CONFIG_DIR!, '.claude.json');
    await writeFile(claudeConfig, JSON.stringify({ numStartups: 1, projects: {} }));
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const botTerminal = async () => {
        const { identity, workbench } = await pageRequest<BotSnapshot>(
            running.page,
            'bot.snapshot',
        );
        return workbench.terminals.find(({ id }) => id === identity.terminalId);
    };
    try {
        await createShellSession(running.page);
        const bot = await openBotWindow(running);
        const pane = bot.locator('.terminal-pane');
        await expect(pane.locator('.xterm-rows')).toContainText('Fake codex ready');
        const before = await botTerminal();
        expect(before?.provider).toBe('codex');

        const agentButton = bot.getByRole('button', { name: "Caxri Bot's Agent: Codex" });
        await agentButton.click();
        await bot.getByRole('menuitemradio', { name: 'Claude' }).click();
        const confirmation = bot.getByRole('dialog', {
            name: 'Switch Caxri Bot to Claude?',
        });
        await confirmation.getByRole('button', { name: 'Switch to Claude' }).click();

        await expect(pane.locator('.xterm-rows')).toContainText('Fake claude ready');
        await expect(bot.getByRole('button', { name: "Caxri Bot's Agent: Claude" })).toBeVisible();
        const after = await botTerminal();
        expect(after).toMatchObject({ id: before!.id, provider: 'claude' });

        const workspace = await realpath(join(userData, 'agent-commander'));
        const config = JSON.parse(await readFile(claudeConfig, 'utf8')) as {
            projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
        };
        expect(config.projects[workspace]?.hasTrustDialogAccepted).toBe(true);
        await testInfo.attach('bot-on-claude', {
            body: await bot.screenshot(),
            contentType: 'image/png',
        });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
