import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
    isContextMenuItemEnabled,
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
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { app, page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        await page
            .getByRole('menu', { name: 'New Terminal' })
            .getByRole('menuitemcheckbox', { name: 'Open in Chat' })
            .click();
        await chooseTerminalFromCreateMenu(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);
        const message = session.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        const { id: terminalId } = await codexTerminal(page);
        const tab = session.locator(`.work-tab:not([inert])[data-terminal-id="${terminalId}"]`);

        // Nothing to carry over before the first turn binds a thread.
        await tab.click({ button: 'right' });
        expect(await isContextMenuItemEnabled(app, 'Open as Terminal')).toBe(false);
        expect(await contextMenuItemDisabledReason(app, 'Open as Terminal')).toBe(
            'Send a message first; there is no conversation to continue yet',
        );
        await dismissContextMenu(app);

        await message.fill('hi there');
        await message.press('Enter');
        await expect(session.getByText('Hello from fake Codex. You said: hi there')).toBeVisible();
        await expect.poll(async () => (await codexTerminal(page)).agentSessionId).toBeTruthy();
        const { agentSessionId: thread } = await codexTerminal(page);

        // Chat to Terminal: the TUI resumes the thread the Chat started.
        await tab.click({ button: 'right' });
        await chooseContextMenuItem(app, 'Open as Terminal');
        const terminalRows = session.locator(
            `.terminal-pane[data-terminal-id="${terminalId}"] .xterm-rows`,
        );
        await expect(terminalRows).toContainText(`Fake Codex TUI on thread ${thread}`);
        await expect(message).toHaveCount(0);
        expect(await codexTerminal(page)).toMatchObject({ agentSessionId: thread });
        expect((await codexTerminal(page)).surface).toBeUndefined();
        await page.screenshot({ path: testInfo.outputPath('surface-switch-terminal.png') });

        // Terminal to Chat: the history comes back from the same thread.
        await tab.click({ button: 'right' });
        await chooseContextMenuItem(app, 'Open as Chat');
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
        // Live work reads in the present tense with its subject, and a thought shows its Codex title.
        await expect(
            session.getByRole('button', { name: /^Running rg -n slow src/u }),
        ).toBeVisible();
        await expect(
            session.getByRole('button', { name: /^Thought Planning the reply/u }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('surface-switch-running-turn.png') });
        // Stop and Send share one slot: typed content turns it into Send, which steers the turn.
        await message.fill('steer');
        await expect(session.getByRole('button', { name: 'Send' })).toBeEnabled();
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
