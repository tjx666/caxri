import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommanderSnapshot } from '@caxri/protocol';
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

async function openCommanderWindow({ app, page: workbench }: RunningCaxri): Promise<Page> {
    await pageRequest(workbench, 'agentCommander.open');
    await expect.poll(() => app.windows().length).toBe(2);
    const commander = app.windows().find((page) => page !== workbench)!;
    await expect(commander.locator('.terminal-pane .terminal-surface')).toHaveAttribute(
        'data-terminal-attached',
        'true',
    );
    return commander;
}

/**
 * The native menu owns `Cmd+Shift+P`, so the Commander window only gets its palette when Main forwards the accelerator
 * to it instead of raising the Workbench palette behind it. The More menu offers the same palette for pointer users.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander opens its own command palette from Cmd+Shift+P and the More menu', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-palette-e2e-'));
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
        const commander = await openCommanderWindow(running);
        const inboxToggle = commander.getByRole('button', { name: /^Needs you/u });
        const wasInboxVisible = (await inboxToggle.getAttribute('aria-pressed')) === 'true';

        /**
         * Electron hands a menu item's click the focused window; passing the Commander's reproduces its accelerator
         * without depending on which app macOS has in front during the run.
         */
        await running.app.evaluate(({ BrowserWindow, Menu }) => {
            const window = BrowserWindow.getAllWindows().find((candidate) =>
                candidate.webContents.getURL().includes('agent-commander.html'),
            );
            const item = Menu.getApplicationMenu()?.getMenuItemById('command.commandPalette.open');
            if (!window || !item) throw new Error('Commander window or Command Palette is missing');
            (item.click as (...parameters: unknown[]) => void)(
                { triggeredByAccelerator: true },
                window,
                window.webContents,
            );
        });
        const input = commander.getByPlaceholder('Type a command or a Session');
        await expect(input).toBeFocused();
        await expect(running.page.getByRole('dialog')).toHaveCount(0);
        await testInfo.attach('commander-palette', {
            body: await commander.screenshot(),
            contentType: 'image/png',
        });

        await input.fill('needs you');
        const toggleRow = wasInboxVisible ? 'Hide Needs you' : 'Show Needs you';
        await commander.getByRole('option', { name: toggleRow }).click();
        await expect(input).toHaveCount(0);
        await expect(inboxToggle).toHaveAttribute('aria-pressed', String(!wasInboxVisible));

        await commander.getByRole('button', { name: 'More', exact: true }).click();
        await commander.getByRole('menuitem', { name: /^Command Palette…/u }).click();
        await expect(input).toBeFocused();
        await commander.keyboard.press('Escape');
        await expect(input).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * Clear Commander Data is destructive, so Main asks the native confirmation first. A cancel there keeps the dialog and
 * its selection; a confirm clears exactly what was ticked and names it.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Clear Commander Data clears what was ticked after the native confirmation', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-clear-data-e2e-'));
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
        await pageRequest(running.page, 'commander.inbox.add', {
            kind: 'decision',
            title: 'Which database should the import use?',
        });
        await pageRequest(running.page, 'commander.inbox.add', {
            kind: 'decision',
            title: 'Approve the release?',
        });
        const chip = running.page.locator('.commander-inbox-chip');
        await expect(chip).toHaveText('2 need you');
        const commander = await openCommanderWindow(running);

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

        await commander.getByRole('button', { name: 'More', exact: true }).click();
        await commander.getByRole('menuitem', { name: 'Clear Commander Data…' }).click();
        const dialog = commander.locator('.commander-clear-data-dialog');
        const inbox = dialog.locator('[data-clear-data="inbox"]');
        await expect(inbox).toContainText('2 open · 0 closed');
        // Nothing is ticked by default when the task ledger is empty, so the dialog cannot clear anything yet.
        const submit = dialog.getByRole('button', { name: 'Clear Data', exact: true });
        await expect(submit).toBeDisabled();
        await inbox.getByRole('checkbox').click();
        await testInfo.attach('commander-clear-data', {
            body: await commander.screenshot(),
            contentType: 'image/png',
        });

        await submit.click();
        await expect.poll(prompts).toHaveLength(1);
        await expect(inbox).toHaveAttribute('data-checked', 'true');
        await expect(chip).toHaveText('2 need you');

        await submit.click();
        await expect(dialog).toHaveCount(0);
        await expect(commander.getByText('Cleared 2 Needs you items')).toBeVisible();
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
 * Switching the Commander's Agent keeps its Terminal, so every task it delegated stays its own. Claude Code would stop
 * at its folder-trust dialog in the Commander workspace, so the switch must pre-grant that trust in Claude's config.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander switches to Claude in place, with its workspace already trusted', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-switch-e2e-'));
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
    const commanderTerminal = async () => {
        const { identity, workbench } = await pageRequest<CommanderSnapshot>(
            running.page,
            'commander.snapshot',
        );
        return workbench.terminals.find(({ id }) => id === identity.terminalId);
    };
    try {
        await createShellSession(running.page);
        const commander = await openCommanderWindow(running);
        const pane = commander.locator('.terminal-pane');
        await expect(pane.locator('.xterm-rows')).toContainText('Fake codex ready');
        const before = await commanderTerminal();
        expect(before?.provider).toBe('codex');

        const agentButton = commander.getByRole('button', { name: 'Commander Agent: Codex' });
        await agentButton.click();
        await commander.getByRole('menuitemradio', { name: 'Claude' }).click();
        const confirmation = commander.getByRole('dialog', {
            name: 'Switch the Commander to Claude?',
        });
        await confirmation.getByRole('button', { name: 'Switch to Claude' }).click();

        await expect(pane.locator('.xterm-rows')).toContainText('Fake claude ready');
        await expect(
            commander.getByRole('button', { name: 'Commander Agent: Claude' }),
        ).toBeVisible();
        const after = await commanderTerminal();
        expect(after).toMatchObject({ id: before!.id, provider: 'claude' });

        const workspace = await realpath(join(userData, 'agent-commander'));
        const config = JSON.parse(await readFile(claudeConfig, 'utf8')) as {
            projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
        };
        expect(config.projects[workspace]?.hasTrustDialogAccepted).toBe(true);
        await testInfo.attach('commander-on-claude', {
            body: await commander.screenshot(),
            contentType: 'image/png',
        });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
