import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
 * A 1x1 PNG for drops and the file picker; the paste path draws a larger one in the page so the thumbnail is visible.
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
 * Pastes a noise PNG over the 5 MB image limit, like a Retina screenshot of dense content; noise does not compress, so
 * the file stays large and the composer must resize it before attaching.
 */
async function pasteOversizedImage(message: Locator): Promise<number> {
    return message.evaluate(async (element) => {
        const width = 2400;
        const height = 1600;
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('2D canvas unavailable');
        const pixels = context.createImageData(width, height);
        const random = new Uint32Array(pixels.data.buffer);
        for (let offset = 0; offset < random.length; offset += 16_384)
            crypto.getRandomValues(random.subarray(offset, offset + 16_384));
        for (let index = 3; index < pixels.data.length; index += 4) pixels.data[index] = 255;
        context.putImageData(pixels, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([blob], 'retina.png', { type: 'image/png' }));
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
        return blob.size;
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
        const attached = chat.getByRole('list', { name: 'Attachments' });
        await expect(attached.getByRole('button', { name: 'Remove screenshot.png' })).toBeVisible();
        // A drop anywhere on the Chat, here the empty transcript far above the input, attaches like one on the composer.
        await dropImage(chat.getByText('Send a message to start working with Codex.'));
        await expect(attached.getByRole('button', { name: 'Remove pixel.png' })).toBeVisible();
        // An image over the 5 MB limit is resized under it and attached, not refused.
        expect(await pasteOversizedImage(message)).toBeGreaterThan(5 * 1024 * 1024);
        await expect(
            attached.getByRole('img', { name: 'retina.png (resized to fit the 5 MB limit)' }),
        ).toBeVisible();
        await message.fill('what are these');
        await page.screenshot({ path: testInfo.outputPath('codex-chat-attachments.png') });
        await message.press('Enter');

        // The Server refuses any image over the limit, so this receipt proves the resized bytes fit.
        await expect(chat.getByText('Received 3 images.')).toBeVisible();
        await expect(attached).toHaveCount(0);
        await expect(chat.getByRole('img', { name: 'Attachment 1' })).toBeVisible();
        await expect(chat.getByRole('img', { name: 'Attachment 2' })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-sent-images.png') });

        // The `/` menu reuses the Agent Commands & Skills discovery, so a Project skill sits beside the commands.
        await message.fill('/');
        const commands = chat.getByRole('listbox', { name: 'Commands and skills' });
        await expect(commands.getByRole('option')).toHaveText([
            /^\/compact/u,
            /^\/goal/u,
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

/**
 * Pastes `text` into the message box the way the system clipboard delivers it.
 */
async function pasteText(message: Locator, text: string): Promise<void> {
    await message.evaluate((element, pasted) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', pasted);
        element.dispatchEvent(
            new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
        );
    }, text);
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat attaches picked files and folders as cards and saves a long paste to a file', async ({}, testInfo) => {
    // The real path, so the picked files sit inside the Project root the Agent runs in, not behind a `/var` symlink.
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-attach-'));
    const directory = await realpath(temporary);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(join(root, 'shots'), { recursive: true });
    // More images than the former limit of four.
    const shots = Array.from({ length: 6 }, (_, index) =>
        join(root, 'shots', `shot-${index + 1}.png`),
    );
    await Promise.all(shots.map((path) => writeFile(path, PIXEL_PNG)));
    const notes = join(root, 'notes.txt');
    await writeFile(notes, 'release notes\n');
    const folder = join(root, 'prettier-config');
    await mkdir(folder);
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        await expect(chat.getByRole('button', { name: 'Add files and more' })).toBeVisible();

        // The picker is the native open panel, so the spec hands its input the chosen files instead of driving it.
        await chat.locator('input[type="file"]').setInputFiles([...shots, notes]);
        const attached = chat.getByRole('list', { name: 'Attachments' });
        // A file that is not an image becomes a card the message cites by path, as in the Codex app.
        await expect(attached.getByRole('listitem')).toHaveCount(shots.length + 1);
        const notesCard = attached.locator(`[data-agent-chat-path-attachment="${notes}"]`);
        await expect(notesCard).toContainText('notes.txt');
        await expect(notesCard).toContainText('File');
        await expect(message).toHaveValue('');
        // `+` → Files and folders opens the native panel, stubbed in Main to choose the folder; Main tells it is one.
        await running.app.evaluate(({ dialog, shell }, chosen) => {
            dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
            const opened: string[][] = [];
            Object.assign(globalThis, { caxriE2EOpenedPaths: opened });
            shell.openPath = (path) => {
                opened.push(['open', path]);
                return Promise.resolve('');
            };
            shell.showItemInFolder = (path) => {
                opened.push(['reveal', path]);
            };
        }, folder);
        await chat.getByRole('button', { name: 'Add files and more' }).click();
        await page.getByRole('menuitem', { name: 'Files and folders' }).click();
        const folderCard = attached.locator(`[data-agent-chat-path-attachment="${folder}"]`);
        await expect(folderCard).toContainText('prettier-config');
        await expect(folderCard).toContainText('Folder');
        await expect(page.getByRole('menu')).toHaveCount(0);
        // `+` → Caxri skill attaches a skill card, and choosing it again from the checked row takes the card away.
        const skillCard = attached.locator('[data-agent-chat-skill-attachment="caxri-cli"]');
        await chat.getByRole('button', { name: 'Add files and more' }).click();
        await page.getByRole('menuitemcheckbox', { name: /Caxri skill/u }).click();
        await expect(skillCard).toContainText('Caxri skill');
        await chat.getByRole('button', { name: 'Add files and more' }).click();
        await expect(page.getByRole('menuitemcheckbox', { name: /Caxri skill/u })).toBeChecked();
        await page.getByRole('menuitemcheckbox', { name: /Caxri skill/u }).click();
        await expect(skillCard).toHaveCount(0);
        await chat.getByRole('button', { name: 'Add files and more' }).click();
        await page.getByRole('menuitemcheckbox', { name: /Caxri skill/u }).click();
        await expect(skillCard).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-attachment-cards.png') });

        const long = Array.from(
            { length: 800 },
            (_, index) => `log line ${index}: ${'x'.repeat(40)}`,
        ).join('\n');
        await pasteText(message, long);
        await expect(message).toHaveValue(/\[Long paste saved locally\]/u);
        const value = await message.inputValue();
        const savedPath = JSON.parse(/Original file: (".*")/u.exec(value)?.[1] ?? '""') as string;
        expect(await readFile(savedPath, 'utf8')).toBe(long);
        expect((await stat(savedPath)).mode & 0o777).toBe(0o600);
        expect(value).not.toContain('log line 1:');
        await page.screenshot({ path: testInfo.outputPath('codex-chat-picked-files.png') });

        await message.press('Enter');
        await expect(chat.getByText(`Received ${shots.length} images.`)).toBeVisible();
        // The sent message shows what it cited as chips under its images instead of the reference block Codex got.
        const sent = chat.locator('[data-agent-chat-user-message]').last();
        await expect(sent).not.toContainText('Files mentioned by the user');
        await expect(sent).not.toContainText('Skills the user asked you to use');
        await expect(sent.locator('[data-agent-chat-skill-reference="caxri-cli"]')).toHaveText(
            'Caxri skill',
        );
        const folderChip = sent.getByRole('button', { name: 'Open prettier-config in Finder' });
        await expect(folderChip).toBeVisible();
        await folderChip.click();
        await sent.getByRole('button', { name: 'Show notes.txt in Finder' }).click();
        await expect
            .poll(() =>
                running.app.evaluate(
                    () => (globalThis as { caxriE2EOpenedPaths?: string[][] }).caxriE2EOpenedPaths,
                ),
            )
            .toEqual([
                ['open', folder],
                ['reveal', notes],
            ]);
        // The sent reference's path is a link that starts on the same line as the quote before it, not on a line of its
        // own the way an atomic inline-block link would.
        const savedLink = chat.getByRole('link', { name: savedPath });
        await expect(savedLink).toBeVisible();
        const lineGap = await savedLink.evaluate((element) => {
            const before = element.previousSibling;
            if (!before?.textContent) return Infinity;
            const quote = document.createRange();
            quote.setStart(before, before.textContent.length - 1);
            quote.setEnd(before, before.textContent.length);
            return Math.abs(quote.getBoundingClientRect().top - element.getClientRects()[0].top);
        });
        expect(lineGap).toBeLessThan(2);
        await page.screenshot({ path: testInfo.outputPath('codex-chat-sent-files.png') });
        await expect(attached).toHaveCount(0);
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
        await expect(chat.getByRole('button', { name: 'Remove screenshot.png' })).toBeVisible();
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

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Chat recalls sent prompts from a list and stashes a draft with Ctrl+S', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-history-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        const send = async (prompt: string): Promise<void> => {
            await message.fill(prompt);
            await message.press('Enter');
            await expect(message).toHaveValue('');
        };
        await send('first prompt');
        await send('second prompt');
        await send('first prompt');
        await expect(chat.getByText('Hello from fake Codex. You said: first prompt')).toHaveCount(
            2,
        );

        // ArrowUp in the empty input opens the list on the newest prompt; a repeat lists once, at its newest place.
        await message.press('ArrowUp');
        const history = chat.getByRole('listbox', { name: 'Recent prompts' });
        await expect(history.getByRole('option')).toHaveText(['second prompt', 'first prompt']);
        await expect(history.getByRole('option', { name: 'first prompt' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(message).toHaveAttribute('placeholder', 'first prompt');
        await message.press('ArrowUp');
        await expect(message).toHaveAttribute('placeholder', 'second prompt');
        await page.screenshot({ path: testInfo.outputPath('chat-prompt-history.png') });
        // Enter fills the input without sending.
        await message.press('Enter');
        await expect(history).toHaveCount(0);
        await expect(message).toHaveValue('second prompt');
        await expect(chat.getByText('Hello from fake Codex. You said: second prompt')).toHaveCount(
            1,
        );

        // Escape closes the list and leaves the input empty; typing closes it and still types.
        await message.fill('');
        await message.press('ArrowUp');
        await expect(history).toBeVisible();
        await message.press('Escape');
        await expect(history).toHaveCount(0);
        await expect(message).toHaveValue('');
        await message.press('ArrowUp');
        await message.press('x');
        await expect(history).toHaveCount(0);
        await expect(message).toHaveValue('x');

        // Ctrl+S sets a long draft aside so a quick question can go first, then brings it back after the send.
        await message.fill('a long draft to finish later');
        await message.press('Control+s');
        await expect(message).toHaveValue('');
        await expect(message).toHaveAttribute('placeholder', 'Draft stashed · Ctrl+S to restore');
        await page.screenshot({ path: testInfo.outputPath('chat-draft-stashed.png') });
        await message.fill('quick question');
        await message.press('Enter');
        await expect(message).toHaveValue('a long draft to finish later');
        // Ctrl+S in an empty input restores a stash on demand too.
        await message.press('Control+s');
        await expect(message).toHaveValue('');
        await message.press('Control+s');
        await expect(message).toHaveValue('a long draft to finish later');
        await expect(message).toHaveAttribute('placeholder', 'Message Codex');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
