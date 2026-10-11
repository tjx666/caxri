import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator } from '@playwright/test';

import {
    fakeClaudeChatAgentMode,
    fakeCodexChatAgentMode,
    openAgentChat,
} from './support/agent-chat-fixture.ts';
import type { E2EApp } from './support/electron-app.ts';
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

/**
 * Records every native confirmation Main shows and answers it with `response`.
 */
async function answerNativeDialogs(app: E2EApp, response: number): Promise<void> {
    await app.evaluate(({ dialog }, answer) => {
        const shown: string[] = [];
        // eslint-disable-next-line unicorn/no-global-object-property-assignment -- read back by a later evaluate in Main
        (globalThis as { shownDialogs?: string[] }).shownDialogs = shown;
        dialog.showMessageBox = ((_window: unknown, options: { message: string }) => {
            shown.push(options.message);
            return Promise.resolve({ checkboxChecked: false, response: answer });
        }) as typeof dialog.showMessageBox;
    }, response);
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat edits an earlier message and reverts its files', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-rewind-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await answerNativeDialogs(running.app, 0);
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        await sendAndSettle(chat, 'first question', /You said: first question/u);
        await sendAndSettle(chat, 'second question', /You said: second question/u);

        await userMessage(chat, 'first question').hover();
        await chat.getByRole('button', { name: 'Edit from here' }).first().click();
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toHaveValue('first question');
        await expect(chat.getByText('2 turns will be replaced', { exact: false })).toBeVisible();
        await chat.getByRole('checkbox').click();
        await page.screenshot({ path: testInfo.outputPath('claude-edit-bar.png') });

        await message.fill('a better first question');
        await message.press('Enter');
        await expect(chat.getByText(/You said: a better first question/u)).toBeVisible();
        await expect(userMessage(chat, 'second question')).toHaveCount(0);
        await expect(chat.locator('[data-agent-chat-edit-bar]')).toHaveCount(0);
        expect(
            await running.app.evaluate(
                () => (globalThis as { shownDialogs?: string[] }).shownDialogs,
            ),
        ).toEqual(['Revert the files Claude changed in these 2 turns?']);
        await page.screenshot({ path: testInfo.outputPath('claude-edited.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat edits only the conversation and Escape cancels', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-rewind-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        await sendAndSettle(chat, 'hello there', /hello there/u);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('unsent draft');

        await userMessage(chat, 'hello there').hover();
        await chat.getByRole('button', { name: 'Edit from here' }).click();
        await expect(message).toHaveValue('hello there');
        await expect(chat.getByRole('checkbox')).toBeDisabled();
        await page.screenshot({ path: testInfo.outputPath('codex-edit-bar.png') });

        await message.press('Escape');
        await expect(message).toHaveValue('unsent draft');
        await expect(chat.locator('[data-agent-chat-edit-bar]')).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
