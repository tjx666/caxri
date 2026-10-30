import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { fakeClaudeChatExecutableSource } from '../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-chat-executables.ts';
import { fakeCodexChatProvider, openAgentChat } from './support/agent-chat-fixture.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';
import {
    chooseContextMenuItem,
    contextMenuItemDisabledReason,
    contextMenuLabels,
    dismissContextMenu,
    isContextMenuItemEnabled,
} from './support/native-context-menu.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat that used up its 5-hour limit continues in Codex in a new Session', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-usage-limit-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: { executableSource: fakeClaudeChatExecutableSource({}) },
            codex: fakeCodexChatProvider(directory, join(userData, 'e2e-agents', 'codex')),
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const source = page.locator(VISIBLE_SESSION);
        const message = source.getByRole('textbox', { name: 'Message' });
        // The fake Claude answers this prompt with a rejected 5-hour limit and Claude Code's synthetic limit reply.
        await message.fill('usage exhausted');
        await message.press('Enter');

        const notice = source.locator('[data-agent-chat-usage-limit="session"]');
        await expect(notice).toContainText('Claude used up its 5-hour limit');
        await expect(notice).toContainText(/resets in/u);
        // The menu lists every other Agent, and says why one that is not installed cannot take over.
        await notice.getByRole('button', { name: 'Choose another Agent' }).click();
        const menu = page.getByRole('menu');
        await expect(
            menu.getByRole('menuitem', { name: /Grok Build.*Not installed/u }),
        ).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape');
        // The limit resets within a day, so the Chat waits to continue on its own.
        const wait = notice.locator('[data-agent-chat-auto-continue="waiting"]');
        await expect(wait).toContainText(/Continues automatically at .+ \(in /u);
        // The Session row says so too, with the time it continues, and clears when the wait ends.
        const rowStatus = page.locator('.session-status[data-session-status="usageWait"]');
        await expect(rowStatus).toHaveAccessibleName('Waiting for limit reset');
        await expect(rowStatus).toHaveAccessibleDescription(/^Continues automatically at /u);
        await page.screenshot({ path: testInfo.outputPath('usage-limit-recovery.png') });
        // Cancel ends the wait and leaves the rest of the card as it was.
        await notice.getByRole('button', { name: 'Cancel' }).click();
        await expect(wait).toHaveCount(0);
        await expect(rowStatus).toHaveCount(0);
        await expect(notice.getByRole('button', { name: 'Continue now' })).toHaveCount(0);

        await notice.getByRole('button', { name: 'Continue in Codex' }).click();

        // The new Session opens on Codex with the package as its first message, and the source links to it.
        const continued = page.locator(VISIBLE_SESSION);
        await expect(continued.getByText('Continued from')).toBeVisible();
        await expect(continued.getByText(/Hello from fake Codex/u)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('usage-limit-continued.png') });
        // "Continued from" links back to the source Session.
        await continued.getByText('Continued from').locator('..').getByRole('button').click();
        const link = page.locator(VISIBLE_SESSION).locator('[data-agent-chat-continued-in]');
        await expect(link).toContainText('Continued in');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat at 99% of its weekly usage refuses new messages and writes one hand-off', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-usage-guard-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: { executableSource: fakeClaudeChatExecutableSource({}) },
            codex: fakeCodexChatProvider(directory, join(userData, 'e2e-agents', 'codex')),
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        // The fake Claude reports the weekly window at 99.5% before it answers.
        await message.fill('weekly nearly used');
        await message.press('Enter');

        const guard = chat.locator('[data-agent-chat-usage-guard]');
        await expect(guard).toContainText('Claude weekly usage at 99%');
        await expect(guard).toContainText(/New requests are paused, resets in/u);
        await expect(chat.getByRole('button', { name: 'Open in another Agent' })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('usage-guard.png') });

        // Enter does nothing while the guard holds; the message stays in the composer.
        await message.fill('one more thing');
        await message.press('Enter');
        await expect(message).toHaveText('one more thing');

        await guard.getByRole('button', { name: 'Generate hand-off' }).click();
        const document = guard.locator('[data-agent-chat-handoff-document]');
        await expect(document).toBeVisible();
        // The hand-off is spent: the account has no second one this week.
        await expect(guard).toHaveAttribute('data-agent-chat-usage-guard', 'used');
        await expect(guard.getByRole('button', { name: 'Generate hand-off' })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('usage-guard-handoff.png') });

        // The headline folds the document and actions away, leaving one line.
        const fold = guard.locator('[data-agent-chat-usage-guard-fold]');
        await fold.click();
        await expect(fold).toHaveAttribute('aria-expanded', 'false');
        await expect(document).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('usage-guard-folded.png') });
        await fold.click();
        await expect(document).toBeVisible();

        // Continue anyway lifts the guard for the rest of the window, and the fake's next 99.5% reading keeps it lifted.
        await guard.getByRole('button', { name: 'Continue anyway' }).click();
        await expect(guard).toHaveCount(0);
        await message.press('Enter');
        await expect(
            chat.locator('[data-agent-chat-user-message]', { hasText: 'one more thing' }),
        ).toBeVisible();
        await expect(guard).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Continue now resumes a Claude Chat waiting for its limit without a visible message', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-usage-limit-wait-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: { executableSource: fakeClaudeChatExecutableSource({}) } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('usage exhausted');
        await message.press('Enter');

        const notice = chat.locator('[data-agent-chat-usage-limit="session"]');
        await expect(notice.locator('[data-agent-chat-auto-continue="waiting"]')).toBeVisible();
        await notice.getByRole('button', { name: 'Continue now' }).click();

        // The continuation is a new turn the Agent answers; the timeline gains no user message for it.
        await expect(chat.getByText(/Hello from fake Claude/u)).toBeVisible();
        await expect(chat.locator('[data-agent-chat-user-message]')).toHaveCount(1);
        await expect(notice.locator('[data-agent-chat-auto-continue]')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('usage-limit-continue-now.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a turn the weekly guard stopped waits for the reset on the guard card and Cancel ends it', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-usage-guard-wait-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: { executableSource: fakeClaudeChatExecutableSource({}) } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        // The fake Claude reports the weekly window at 99.5% (resetting in 2 hours) while a long reply streams.
        await message.fill('weekly guard');
        await message.press('Enter');

        const guard = chat.locator('[data-agent-chat-usage-guard]');
        const wait = guard.locator('[data-agent-chat-auto-continue="waiting"]');
        await expect(wait).toContainText(/Continues automatically at .+ \(in /u);
        // The guard still refuses requests, so there is nothing to continue now.
        await expect(guard.getByRole('button', { name: 'Continue now' })).toHaveCount(0);
        const rowStatus = page.locator('.session-status[data-session-status="usageWait"]');
        await expect(rowStatus).toHaveAccessibleName('Waiting for limit reset');
        await page.screenshot({ path: testInfo.outputPath('usage-guard-wait.png') });

        await guard.getByRole('button', { name: 'Cancel' }).click();
        await expect(wait).toHaveCount(0);
        await expect(rowStatus).toHaveCount(0);
        // Only Claude is installed here, so the guard's other way forward reads as unavailable.
        await expect(guard.getByText('No other Agent can take this over')).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * One fake `claude` for both surfaces: the Chat's stream-json launch runs the deterministic fixture, and any other
 * launch is a stand-in TUI, which is all the PTY side of a surface switch needs.
 */
const CLAUDE_CHAT_AND_PTY_SOURCE = String.raw`#!${process.execPath}
if (process.argv.includes('--input-format')) {
  import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-cli.ts')).href)});
} else if (process.argv.includes('--version')) {
  process.stdout.write('2.1.251 (Claude Code)\n');
} else {
  process.stdout.write('Fake Claude TUI ready\r\n');
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
}
`;

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a PTY Claude Terminal shows the weekly guard of its account without being interrupted', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-usage-guard-pty-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: { executableSource: CLAUDE_CHAT_AND_PTY_SOURCE } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const session = page.locator(VISIBLE_SESSION);
        const surfaceSwitch = session.getByRole('group', { name: 'Open as Terminal or Chat' });
        // Before any reading the account is not at the guard, so the PTY carries no notice.
        await surfaceSwitch.getByRole('button', { name: 'Terminal' }).click();
        const rows = session.locator('.terminal-pane .xterm-rows');
        await expect(rows).toContainText('Fake Claude TUI ready');
        await expect(session.locator('[data-terminal-usage-guard]')).toHaveCount(0);
        await surfaceSwitch.getByRole('button', { name: 'Chat' }).click();

        // The fake Claude reports the weekly window at 99.5% before it answers; the Chat is refused from then on.
        const message = session.getByRole('textbox', { name: 'Message' });
        await message.fill('weekly nearly used');
        await message.press('Enter');
        await expect(session.locator('[data-agent-chat-usage-guard]')).toContainText(
            'Claude weekly usage at 99%',
        );

        // The same account in a PTY Terminal: the notice appears, the Terminal keeps running and takes input.
        await surfaceSwitch.getByRole('button', { name: 'Terminal' }).click();
        const notice = session.locator('[data-terminal-usage-guard]');
        await expect(notice).toContainText('Claude weekly usage at 99%');
        await expect(notice).toContainText(/resets in/u);
        await expect(rows).toContainText('Fake Claude TUI ready');
        await page.screenshot({ path: testInfo.outputPath('usage-guard-terminal.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('an idle Claude Chat continues in Codex from its tab menu, and its Session row offers the same', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-continue-menu-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: { executableSource: fakeClaudeChatExecutableSource({}) },
            codex: fakeCodexChatProvider(directory, join(userData, 'e2e-agents', 'codex')),
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { app, page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const source = page.locator(VISIBLE_SESSION);
        const sourceId = await source.getAttribute('data-workbench-session-id');
        const tab = source.locator('.work-tab:not([inert])').filter({ hasText: 'Claude' });

        // Before the first turn there is no conversation to hand over.
        await tab.click({ button: 'right' });
        expect(await contextMenuItemDisabledReason(app, 'Continue in Another Agent')).toBe(
            'This Agent has no conversation yet',
        );
        await dismissContextMenu(app);

        const message = source.getByRole('textbox', { name: 'Message' });
        await message.fill('plan the refactor');
        await message.press('Enter');
        await expect(source.getByText(/You said: plan the refactor/u)).toBeVisible();
        await expect(source.getByRole('button', { name: 'Send' })).toBeVisible();

        // The Session row offers the Primary Agent's continuation beside Fork Session.
        await page
            .locator(`.project-group [data-session-id="${sourceId}"]`)
            .click({ button: 'right' });
        const rowLabels = await contextMenuLabels(app);
        expect(
            rowLabels.slice(
                rowLabels.indexOf('Fork Session'),
                rowLabels.indexOf('Fork Session') + 2,
            ),
        ).toEqual(['Fork Session', 'Continue in Another Agent']);
        await dismissContextMenu(app);

        // The tab's submenu lists the other Agents, the missing one disabled with why.
        await tab.click({ button: 'right' });
        expect(await isContextMenuItemEnabled(app, ['Continue in Another Agent', 'Codex'])).toBe(
            true,
        );
        expect(
            await contextMenuItemDisabledReason(app, ['Continue in Another Agent', 'Grok Build']),
        ).toBe('Not installed');
        await chooseContextMenuItem(app, ['Continue in Another Agent', 'Codex']);

        const continued = page.locator(VISIBLE_SESSION);
        await expect(continued).not.toHaveAttribute('data-workbench-session-id', sourceId ?? '');
        await expect(continued.getByText('Continued from')).toBeVisible();
        await expect(continued.getByText(/Hello from fake Codex/u)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('continue-menu-continued.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
