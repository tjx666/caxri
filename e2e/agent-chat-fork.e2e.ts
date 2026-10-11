import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator } from '@playwright/test';

import {
    fakeClaudeChatAgentMode,
    fakeCodexChatAgentMode,
    openAgentChat,
} from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

async function sendAndSettle(chat: Locator, text: string, reply: RegExp): Promise<void> {
    const message = chat.getByRole('textbox', { name: 'Message' });
    await message.fill(text);
    await message.press('Enter');
    await expect(chat.getByText(reply).last()).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Send' })).toBeVisible();
}

function userMessage(chat: Locator, text: string): Locator {
    return chat.locator('[data-agent-chat-user-message]').filter({ hasText: text });
}

async function temporaryRoot() {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-fork-'));
    const directory = await realpath(created);
    const root = join(directory, 'project');
    await mkdir(root);
    return { directory, root, userData: join(directory, 'user-data') };
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat forks from an earlier message into a new Session', async ({}, testInfo) => {
    const { directory, root, userData } = await temporaryRoot();
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        await sendAndSettle(chat, 'first question', /You said: first question/u);
        await sendAndSettle(chat, 'second question', /You said: second question/u);
        const source = await chat.getAttribute('data-workbench-session-id');

        const forkedFrom = userMessage(chat, 'second question');
        await forkedFrom.hover();
        await forkedFrom.getByRole('button', { name: 'Fork from here' }).click();

        const forked = page.locator(VISIBLE_SESSION);
        await expect(forked).not.toHaveAttribute('data-workbench-session-id', source ?? '');
        const message = forked.getByRole('textbox', { name: 'Message' });
        await expect(message).toHaveValue('second question');
        await expect(userMessage(forked, 'first question')).toBeVisible();
        await expect(userMessage(forked, 'second question')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('claude-forked.png') });

        await message.fill('a different second question');
        await message.press('Enter');
        await expect(forked.getByText(/You said: a different second question/u)).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat forks its first message into an empty Chat', async ({}, testInfo) => {
    const { directory, root, userData } = await temporaryRoot();
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        await sendAndSettle(chat, 'hello there', /hello there/u);

        const forkedFrom = userMessage(chat, 'hello there');
        await forkedFrom.hover();
        await forkedFrom.getByRole('button', { name: 'Fork from here' }).click();

        const forked = page.locator(VISIBLE_SESSION);
        await expect(forked.getByRole('textbox', { name: 'Message' })).toHaveValue('hello there');
        await expect(forked.locator('[data-agent-chat-user-message]')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('codex-forked.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
