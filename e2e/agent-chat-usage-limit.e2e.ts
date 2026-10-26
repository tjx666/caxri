import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
        await page.screenshot({ path: testInfo.outputPath('usage-limit-recovery.png') });
        // Cancel ends the wait and leaves the rest of the card as it was.
        await notice.getByRole('button', { name: 'Cancel' }).click();
        await expect(wait).toHaveCount(0);
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
