import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator } from '@playwright/test';

import { expectComposerValue } from './support/agent-chat-composer.ts';
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

function userMessage(chat: Locator, text: RegExp | string): Locator {
    return chat.locator('[data-agent-chat-user-message]').filter({ hasText: text });
}

/**
 * Records every native confirmation Main shows and answers it with `response`.
 */
async function answerNativeDialogs(app: E2EApp, response: number): Promise<void> {
    await app.evaluate(({ dialog }, answer) => {
        const shown: string[] = [];
        const details: string[] = [];
        // eslint-disable-next-line unicorn/no-global-object-property-assignment -- read back by a later evaluate in Main
        (globalThis as { shownDialogs?: string[] }).shownDialogs = shown;
        // eslint-disable-next-line unicorn/no-global-object-property-assignment -- read back by a later evaluate in Main
        (globalThis as { shownDialogDetails?: string[] }).shownDialogDetails = details;
        dialog.showMessageBox = ((
            _window: unknown,
            options: { message: string; detail?: string },
        ) => {
            shown.push(options.message);
            details.push(options.detail ?? '');
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
        await expectComposerValue(message, 'first question');
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

        // The replaced turns stay viewable, read-only, behind the edited message's switcher.
        await expect(chat.getByRole('status', { name: 'Version 2 of 2' })).toBeVisible();
        await chat.getByRole('button', { name: 'Previous version' }).click();
        await expect(chat.getByRole('status', { name: 'Version 1 of 2' })).toBeVisible();
        await expect(userMessage(chat, 'second question')).toBeVisible();
        await userMessage(chat, 'second question').hover();
        await expect(chat.getByRole('button', { name: 'Edit from here' })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('claude-earlier-version.png') });
        await chat.getByRole('button', { name: 'Show current version' }).click();
        await expect(userMessage(chat, 'second question')).toHaveCount(0);
        await expect(chat.getByRole('status', { name: 'Version 2 of 2' })).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat restores code to an earlier message and keeps the conversation', async ({}, testInfo) => {
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
        const restore = chat.getByRole('button', { name: 'Restore code to here' }).first();
        await expect(restore).toBeEnabled();
        await page.screenshot({ path: testInfo.outputPath('claude-restore-code-action.png') });
        await restore.click();
        await expect
            .poll(() =>
                running.app.evaluate(
                    () => (globalThis as { shownDialogs?: string[] }).shownDialogs,
                ),
            )
            .toEqual(['Revert the files Claude changed in these 2 turns?']);
        // The dialog lists the files the dry run found, with the totals (the fake CLI reports two files).
        const [detail] =
            (await running.app.evaluate(
                () => (globalThis as { shownDialogDetails?: string[] }).shownDialogDetails,
            )) ?? [];
        expect(detail).toContain('2 files will be reverted (+4 -1)');
        expect(detail).toContain('notes.md');
        // The conversation stays: both questions and their replies are still there.
        await expect(userMessage(chat, 'second question')).toHaveCount(1);
        await expect(chat.getByText(/You said: second question/u)).toBeVisible();
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
        await expectComposerValue(message, 'hello there');
        await expect(chat.getByRole('checkbox')).toBeDisabled();
        await expect(chat.getByRole('button', { name: 'Restore code to here' })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('codex-edit-bar.png') });

        await message.press('Escape');
        await expectComposerValue(message, 'unsent draft');
        await expect(chat.locator('[data-agent-chat-edit-bar]')).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * Sends `text` to a Codex Chat and waits for the turn to end; the fake Codex reply does not repeat the message.
 */
async function sendCodexTurn(chat: Locator, text: string): Promise<void> {
    const message = chat.getByRole('textbox', { name: 'Message' });
    await message.fill(text);
    await message.press('Enter');
    await expect(userMessage(chat, text)).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0);
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat shows an edit at once while the Agent restarts', async ({}, testInfo) => {
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
        await sendCodexTurn(chat, 'first question');
        await sendCodexTurn(chat, 'second question');

        await userMessage(chat, 'second question').hover();
        await chat.getByRole('button', { name: 'Edit from here' }).click();
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expectComposerValue(message, 'second question');
        // The restart after the rewind resumes slowly, holding the edit request open, as a slow startup hook does.
        await writeFile(join(directory, 'codex-threads', 'resume-delay-ms'), '4000');
        await message.fill('a better second question');
        await message.press('Enter');
        // The pending row, before Server Core has rewound, restarted, and sent.
        await expect(chat.getByText('a better second question', { exact: true })).toBeVisible({
            timeout: 1500,
        });
        await expect(userMessage(chat, /^second question$/u)).toHaveCount(0, { timeout: 1500 });
        await expect(userMessage(chat, 'first question')).toHaveCount(1);
        await page.screenshot({ path: testInfo.outputPath('codex-edit-pending.png') });

        await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0, {
            timeout: 15_000,
        });
        await expect(userMessage(chat, 'a better second question')).toHaveCount(1);
        await expect(userMessage(chat, /^second question$/u)).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
