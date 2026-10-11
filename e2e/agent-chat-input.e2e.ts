import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

/**
 * A 1x1 PNG for the file picker; the paste path draws a larger one in the page so the thumbnail is visible.
 */
const PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'base64',
);

/**
 * Pastes a generated PNG into the message box the way the system clipboard delivers a screenshot.
 */
async function pasteImage(message: Locator): Promise<void> {
    await message.evaluate(async (element) => {
        const canvas = new OffscreenCanvas(96, 64);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('2D canvas unavailable');
        const gradient = context.createLinearGradient(0, 0, 96, 64);
        gradient.addColorStop(0, '#3b82f6');
        gradient.addColorStop(1, '#f97316');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 96, 64);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }));
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
    });
}

/**
 * Drops a PNG from another application onto `target` with the drag events Chromium dispatches.
 */
async function dropImage(target: Locator): Promise<void> {
    await target.evaluate((element, base64) => {
        const bytes = Uint8Array.from(atob(base64), (character) => character.codePointAt(0) ?? 0);
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }));
        for (const type of ['dragenter', 'dragover', 'drop'])
            element.dispatchEvent(
                new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
            );
    }, PIXEL_PNG.toString('base64'));
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat sends pasted and dropped images and runs /compact', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-input-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const skillDirectory = join(root, '.agents', 'skills', 'review-pr');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
        join(skillDirectory, 'SKILL.md'),
        '---\nname: review-pr\ndescription: Review the open pull request\n---\n\nReview it.\n',
    );
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();

        await pasteImage(message);
        const attached = chat.getByRole('list', { name: 'Attached images' });
        await expect(attached.getByRole('button', { name: 'Remove image 1' })).toBeVisible();
        // A drop anywhere on the Chat, here the empty transcript far above the input, attaches like one on the composer.
        await dropImage(chat.getByText('Send a message to start working with Codex.'));
        await expect(attached.getByRole('button', { name: 'Remove image 2' })).toBeVisible();
        await message.fill('what are these');
        await page.screenshot({ path: testInfo.outputPath('codex-chat-attachments.png') });
        await message.press('Enter');

        await expect(chat.getByText('Received 2 images.')).toBeVisible();
        await expect(attached).toHaveCount(0);
        await expect(chat.getByRole('img', { name: 'Attachment 1' })).toBeVisible();
        await expect(chat.getByRole('img', { name: 'Attachment 2' })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-sent-images.png') });

        // The `/` menu reuses the Agent Commands & Skills discovery, so a Project skill sits beside the commands.
        await message.fill('/');
        const commands = chat.getByRole('listbox', { name: 'Commands and skills' });
        await expect(commands.getByRole('option')).toHaveText([
            /^\/compact/u,
            /^\$review-pr\s*Review the open pull request$/u,
        ]);
        await page.screenshot({ path: testInfo.outputPath('codex-chat-commands.png') });
        // Escape dismisses the list for this draft only; clearing the box and typing `/` again reopens it.
        await message.press('Escape');
        await expect(commands).toHaveCount(0);
        await message.fill('');
        await message.fill('/');
        await expect(commands.getByRole('option').first()).toHaveText(/^\/compact/u);
        await message.fill('$rev');
        await expect(commands.getByRole('option').first()).toHaveText(/^\$review-pr/u);
        await message.press('Enter');
        await expect(message).toHaveValue('$review-pr ');
        await expect(commands).toHaveCount(0);

        await message.fill('/');
        await expect(commands.getByRole('option').first()).toHaveText(/^\/compact/u);
        await message.press('Enter');
        await expect(commands).toHaveCount(0);
        await expect(chat.getByText('Context compacted')).toBeVisible();
        await expect(message).toHaveValue('');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test("a Claude Code Chat sends an image, restores its preview on resume, and offers Claude Code's slash commands", async ({}, testInfo) => {
    /**
     * Claude Code keys its transcript directory by its real working directory, so the Project root must be resolved.
     */
    const created = await mkdtemp(join(tmpdir(), 'caxri-claude-chat-input-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toHaveAttribute('placeholder', 'Message Claude');

        await pasteImage(message);
        await expect(chat.getByRole('button', { name: 'Remove image 1' })).toBeVisible();
        // An image alone is a message.
        await message.press('Enter');
        await expect(chat.getByText('Received 1 image.')).toBeVisible();
        await expect(chat.getByRole('img', { name: 'Attachment 1' })).toBeVisible();

        await message.fill('/');
        const commands = chat.getByRole('listbox', { name: 'Commands and skills' });
        // Commands that only make sense in Claude Code's own terminal UI (here /exit) are not offered.
        await expect(commands.getByRole('option')).toHaveText([/^\/compact/u, /^\/review/u]);
        await message.press('ArrowDown');
        await expect(commands.getByRole('option', { name: /^\/review/u })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await message.press('ArrowUp');
        await page.screenshot({ path: testInfo.outputPath('claude-chat-commands.png') });
        // /compact takes arguments, so Tab completes it instead of running it.
        await message.press('Tab');
        await expect(message).toHaveValue('/compact ');
        await expect(commands).toHaveCount(0);
        await message.press('Enter');
        await expect(chat.getByText('Context compacted')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-compacted.png') });

        // A resumed conversation rebuilds the message from the transcript, which keeps the image but not its preview;
        // the preview is read back from the transcript instead of staying a placeholder.
        await message.fill('crash now');
        await message.press('Enter');
        const failure = chat.getByRole('alert').filter({ hasText: 'Claude stopped unexpectedly' });
        await failure.getByRole('button', { name: 'Retry' }).click();
        await expect(failure).toHaveCount(0);
        await expect(chat.getByText('Received 1 image.')).toBeVisible();
        const restored = chat.locator('img[alt="Attachment 1"]');
        await expect(restored).toHaveAttribute('src', /^data:image\/jpeg;base64,/u);
        await expect(restored).toHaveJSProperty('complete', true);
        await page.screenshot({ path: testInfo.outputPath('claude-chat-restored-image.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
