import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { Page } from '@playwright/test';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    VISIBLE_SESSION,
} from './support/helpers.ts';
import {
    chooseContextMenuItem,
    contextMenuItemDisabledReason,
    dismissContextMenu,
} from './support/native-context-menu.ts';

const FAKE_APP_SERVER = join(
    import.meta.dirname,
    '..',
    'apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-app-server.ts',
);

interface SwitchTerminal {
    id: string;
    kind: string;
    agentSessionId?: string;
    surface?: string;
}

async function codexTerminal(page: Page): Promise<SwitchTerminal> {
    const { terminals } = await pageRequest<{ terminals: SwitchTerminal[] }>(
        page,
        'app.bootstrap',
        {},
    );
    return terminals.find((terminal) => terminal.kind === 'codex')!;
}

/**
 * One fake `codex` for both surfaces: `app-server` runs the deterministic Server-test fixture, and any other launch is
 * a stand-in TUI that prints which thread it resumed, which is all the PTY side of a switch needs to prove.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Agent switches between Chat and Terminal on the same thread', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-surface-switch-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.162.0\n');
  process.exit(0);
}
if (process.argv.includes('app-server')) {
  process.env.FAKE_CODEX_STATE_DIR = ${JSON.stringify(join(directory, 'codex-threads'))};
  import(${JSON.stringify(pathToFileURL(FAKE_APP_SERVER).href)});
} else {
  const resume = process.argv.indexOf('resume');
  process.stdout.write('Fake Codex TUI on thread ' + (resume === -1 ? 'new' : process.argv[resume + 1]) + '\r\n');
  process.stdin.resume();
}
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        const { app, page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        await page
            .getByRole('menu', { name: 'New Terminal' })
            .getByRole('menuitemcheckbox', { name: 'Open Agents in Chat' })
            .click();
        await chooseTerminalFromCreateMenu(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);
        const message = session.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        const { id: terminalId } = await codexTerminal(page);
        const tab = session.locator(`.work-tab:not([inert])[data-terminal-id="${terminalId}"]`);

        const terminalRows = session.locator(
            `.terminal-pane[data-terminal-id="${terminalId}"] .xterm-rows`,
        );
        // The tab rail's Terminal | Chat switch shows which view the active Agent is in.
        const surfaceSwitch = session.getByRole('group', { name: 'Open as Terminal or Chat' });
        await expect(surfaceSwitch.getByRole('button', { name: 'Chat' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await surfaceSwitch.screenshot({
            path: testInfo.outputPath('surface-switch-toggle-chat.png'),
        });

        // Before the first turn binds a thread there is nothing to resume, so there is no command to copy yet.
        await tab.click({ button: 'right' });
        expect(await contextMenuItemDisabledReason(app, 'Copy Resume Command')).toBe(
            'Send a message first; there is no conversation to resume yet',
        );
        await dismissContextMenu(app);
        // ...but the Agent still switches: the other surface starts a new conversation.
        await surfaceSwitch.getByRole('button', { name: 'Terminal' }).click();
        await expect(terminalRows).toContainText('Fake Codex TUI on thread new');
        await expect(surfaceSwitch.getByRole('button', { name: 'Terminal' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await page.screenshot({ path: testInfo.outputPath('surface-switch-unbound-terminal.png') });
        // Cmd+Shift+J switches back from the focused grid.
        const terminalInput = session.locator(
            `.terminal-pane[data-terminal-id="${terminalId}"] .xterm-helper-textarea`,
        );
        await terminalInput.focus();
        await expect(terminalInput).toBeFocused();
        await page.keyboard.press('Meta+Shift+J');
        await expect(message).toBeVisible();
        expect((await codexTerminal(page)).surface).toBe('chat');

        await message.fill('hi there');
        await message.press('Enter');
        await expect(session.getByText('Hello from fake Codex. You said: hi there')).toBeVisible();
        await expect.poll(async () => (await codexTerminal(page)).agentSessionId).toBeTruthy();
        const { agentSessionId: thread } = await codexTerminal(page);

        // Coming back to the Chat's tab puts the cursor in the composer, as a Terminal tab focuses its grid.
        const shellTab = session.locator(
            `.work-tab:not([inert])[data-terminal-id]:not([data-terminal-id="${terminalId}"])`,
        );
        await shellTab.click();
        await expect(message).toHaveCount(0);
        await tab.click();
        await expect(message).toBeFocused();
        await message.locator('xpath=ancestor::form[1]').screenshot({
            path: testInfo.outputPath('surface-switch-focused-composer.png'),
        });
        // Roving tab navigation keeps the keyboard on the tab bar, again as it does for a Terminal.
        const chatTabButton = tab.getByRole('tab');
        await chatTabButton.focus();
        await chatTabButton.press('ArrowLeft');
        await expect(message).toHaveCount(0);
        await shellTab.getByRole('tab').press('ArrowRight');
        await expect(message).toBeVisible();
        await page.evaluate(
            () =>
                new Promise((resolve) => {
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => requestAnimationFrame(resolve)),
                    );
                }),
        );
        await expect(chatTabButton).toBeFocused();

        // Chat to Terminal: the TUI resumes the thread the Chat started.
        await tab.click({ button: 'right' });
        await chooseContextMenuItem(app, 'Open as Terminal');
        await expect(terminalRows).toContainText(`Fake Codex TUI on thread ${thread}`);
        await expect(message).toHaveCount(0);
        expect(await codexTerminal(page)).toMatchObject({ agentSessionId: thread });
        expect((await codexTerminal(page)).surface).toBeUndefined();
        await page.screenshot({ path: testInfo.outputPath('surface-switch-terminal.png') });

        // The resume command continues the same thread in the user's own terminal.
        await tab.click({ button: 'right' });
        await chooseContextMenuItem(app, 'Copy Resume Command');
        const resumeCommand = `cd ${await realpath(root)} && codex resume ${thread}`;
        await expect.poll(() => running.clipboard.textEquals(resumeCommand)).toBe(true);
        await running.clipboard.claimText(resumeCommand);

        // Terminal to Chat through the tab rail switch: the history comes back from the same thread.
        await surfaceSwitch.getByRole('button', { name: 'Chat' }).click();
        await expect(session.getByText('Hello from fake Codex. You said: hi there')).toBeVisible();
        expect(await codexTerminal(page)).toMatchObject({
            agentSessionId: thread,
            surface: 'chat',
        });
        await page.screenshot({ path: testInfo.outputPath('surface-switch-chat.png') });

        // A running turn is never ended silently: Cancel keeps it, Stop and Switch ends it.
        await message.fill('slow please');
        await message.press('Enter');
        await expect(session.getByRole('button', { name: 'Stop' })).toBeVisible();
        // The status tab on the composer names the turn under a moving highlight and counts its time.
        await expect(
            session.getByRole('status').filter({ hasText: /^[A-Z][\w -]+…$/u }),
        ).toHaveCount(1);
        await expect(session.locator('.activity-shimmer').first()).toHaveCSS(
            'animation-name',
            'activity-shimmer',
        );
        await expect(session.getByText('Esc to stop')).toBeVisible();
        await expect(session.getByText(/^\d+s$/u)).toBeVisible();
        // Live work reads in the present tense with its subject, sweeping the highlight across the whole title, and a
        // thought shows its Codex title.
        const liveRow = session.getByRole('button', { name: 'Searching slow in src' });
        await expect(liveRow).toBeVisible();
        await expect(
            liveRow
                .locator('xpath=..')
                .locator('.activity-shimmer')
                .filter({ hasText: 'Searching' })
                .filter({ hasText: 'slow in src' }),
        ).toHaveCount(1);
        // The thought folds into the live summary with the command (`splitAgentChatWork`); expanding the summary lists
        // it with its Codex title.
        const thought = session.getByRole('button', { name: /^Thought Planning the reply/u });
        await expect(thought).toHaveCount(0);
        await liveRow.click();
        await expect(thought).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('surface-switch-running-turn.png') });
        // The expanded list repeats the command as its own row, so collapse through the summary that is now open.
        await session
            .getByRole('button', { name: 'Searching slow in src', expanded: true })
            .click();
        await expect(thought).toHaveCount(0);
        // Stop and Queue share one slot: typed content turns it into Queue message; Cmd+Enter steers instead.
        await message.fill('steer');
        await expect(session.getByRole('button', { name: 'Queue message' })).toBeEnabled();
        await expect(session.getByRole('button', { name: 'Stop' })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('surface-switch-steer-draft.png') });
        await message.fill('');
        await expect(session.getByRole('button', { name: 'Stop' })).toBeVisible();
        await tab.click({ button: 'right' });
        await chooseContextMenuItem(app, 'Open as Terminal');
        const confirm = page.getByRole('dialog', { name: 'Stop the running turn?' });
        await expect(confirm).toContainText(
            'Codex is still working. Switching stops the current turn and continues the conversation in the Terminal.',
        );
        await page.screenshot({ path: testInfo.outputPath('surface-switch-confirm.png') });
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        await expect(confirm).toHaveCount(0);
        await expect(message).toBeVisible();
        expect((await codexTerminal(page)).surface).toBe('chat');

        await tab.click({ button: 'right' });
        await chooseContextMenuItem(app, 'Open as Terminal');
        await confirm.getByRole('button', { name: 'Stop and Switch' }).click();
        await expect(terminalRows).toContainText(`Fake Codex TUI on thread ${thread}`);
        expect(await codexTerminal(page)).toMatchObject({ agentSessionId: thread });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
