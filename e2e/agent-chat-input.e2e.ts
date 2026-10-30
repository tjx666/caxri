import { Buffer } from 'node:buffer';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { Locator } from '@playwright/test';

import {
    BUILT_IN_COMMAND_ROWS,
    composerValue,
    expectComposerValue,
    pressTimes,
} from './support/agent-chat-composer.ts';
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
test('a Codex Chat sends pasted and dropped images, restores their previews on resume, and runs /compact', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-input-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const skillDirectory = join(root, '.agents', 'skills', 'review-pr');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
        join(skillDirectory, 'SKILL.md'),
        '---\nname: review-pr\ndescription: Review the open pull request\n---\n\nReview it.\n',
    );
    const agentMode = await fakeCodexChatAgentMode(directory, userData, {
        shouldWriteRollouts: true,
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();

        await message.fill('what are these');
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
        // Each image is written into the message where the caret was, drawn as a numbered pill matching its thumbnail.
        await expectComposerValue(message, 'what are these [Image #1] [Image #2] [Image #3] ');
        await expect(chat.locator('.cm-image-pill')).toHaveCount(3);
        await expect(attached.locator('[data-attachment-token="1"]')).toHaveText('#1');
        // Deleting a pill removes its image, and undo brings both back.
        await message.press('End');
        await message.press('ArrowLeft');
        await message.press('Backspace');
        await expect(attached.getByRole('button', { name: /^Remove retina\.png/u })).toHaveCount(0);
        // Like deleting a word, the spaces on either side of the pill stay.
        await expectComposerValue(message, 'what are these [Image #1] [Image #2]  ');
        await message.press('Meta+z');
        await expectComposerValue(message, 'what are these [Image #1] [Image #2] [Image #3] ');
        await expect(attached.getByRole('button', { name: /^Remove retina\.png/u })).toBeVisible();
        // Clicking a pill opens its image's preview, which stays open past the click that opened it.
        await chat.locator('.cm-image-pill[data-image-token="2"]').click();
        await expect(page.getByRole('dialog', { name: 'pixel.png' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('codex-chat-attachments.png') });
        await message.press('Enter');

        // The Server refuses any image over the limit, so this receipt proves the resized bytes fit.
        await expect(chat.getByText('Received 3 images.')).toBeVisible();
        await expect(attached).toHaveCount(0);
        await expect(chat.getByRole('img', { name: 'Image 1' })).toBeVisible();
        await expect(chat.getByRole('img', { name: 'Image 2' })).toBeVisible();
        await expect(chat.locator('[data-agent-chat-image-pill]')).toHaveCount(3);
        await page.screenshot({ path: testInfo.outputPath('codex-chat-sent-images.png') });
        // The images sit in the message's bubble under its text, and the larger preview shows the image as sent rather
        // than its thumbnail scaled up.
        const bubble = chat.locator('[data-agent-chat-user-bubble]').filter({
            hasText: 'what are these',
        });
        await expect(bubble.getByRole('button', { name: /^Preview Image 1/u })).toBeVisible();
        await bubble.getByRole('button', { name: /^Preview Image 2/u }).click();
        const preview = page.getByRole('dialog', { name: 'Image 2' });
        await expect(preview.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/u);
        // Left and Right step through the message's images.
        await page.keyboard.press('ArrowRight');
        await expect(page.getByRole('dialog', { name: 'Image 3' })).toContainText('3 / 3');
        await page.keyboard.press('Escape');

        // A resumed thread knows only how many images the message had; each preview is read back from the rollout.
        await message.fill('crash now');
        await message.press('Enter');
        const failure = chat.getByRole('alert').filter({ hasText: 'Codex stopped unexpectedly' });
        await failure.getByRole('button', { name: 'Retry' }).click();
        await expect(failure).toHaveCount(0);
        await expect(chat.getByText('Received 3 images.')).toBeVisible();
        await Promise.all(
            ['Image 1', 'Image 2', 'Image 3'].map(async (name) => {
                const restored = bubble.locator(`img[alt="${name}"]`);
                await expect(restored).toHaveAttribute('src', /^data:image\/jpeg;base64,/u);
                await expect(restored).toHaveJSProperty('complete', true);
            }),
        );
        await page.screenshot({ path: testInfo.outputPath('codex-chat-restored-images.png') });

        // The `/` menu reuses Agent Commands & Skills discovery, so a Project skill follows Caxri's `/new-session`.
        await message.fill('/');
        const commands = chat.getByRole('listbox', { name: 'Commands and skills' });
        await expect(commands.getByRole('option')).toHaveText([
            ...BUILT_IN_COMMAND_ROWS,
            /^\/compact/u,
            /^\/review/u,
            /^\/goal/u,
            /^\$review-pr\s*Review the open pull request$/u,
        ]);
        await page.screenshot({ path: testInfo.outputPath('codex-chat-commands.png') });
        // Escape dismisses the list for this draft only; clearing the box and typing `/` again reopens it.
        await message.press('Escape');
        await expect(commands).toHaveCount(0);
        await message.fill('');
        await message.fill('/');
        await expect(commands.getByRole('option').first()).toHaveText(/^\/new-session/u);
        await message.fill('$rev');
        await expect(commands.getByRole('option').first()).toHaveText(/^\$review-pr/u);
        // Tab stops at the inserted invocation so a request can follow it; Enter would run the skill.
        await message.press('Tab');
        await expectComposerValue(message, '$review-pr ');
        await expect(commands).toHaveCount(0);
        // A row picked from the menu leads a bare `/` next time, under its own heading, and is not repeated below.
        await message.fill('/');
        await expect(commands.getByRole('option')).toHaveText([
            /^\$review-pr/u,
            ...BUILT_IN_COMMAND_ROWS,
            /^\/compact/u,
            /^\/review/u,
            /^\/goal/u,
        ]);
        await expect(commands.getByText('Recently Used', { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-recent-commands.png') });
        await pressTimes(message, 'ArrowDown', BUILT_IN_COMMAND_ROWS.length + 1);
        await message.press('Enter');
        await expect(commands).toHaveCount(0);
        await expect(chat.getByText('Context compacted')).toBeVisible();
        await expectComposerValue(message, '');
        // Enter on a skill runs it as its own message instead of only inserting it.
        await message.fill('$rev');
        await expect(commands.getByRole('option').first()).toHaveText(/^\$review-pr/u);
        await message.press('Enter');
        await expect(commands).toHaveCount(0);
        await expectComposerValue(message, '');
        await expect(
            chat.locator('[data-agent-chat-user-bubble]').filter({ hasText: 'review-pr' }),
        ).toBeVisible();

        // A reply's inline code naming a discovered skill shows the skill icon; hovering it reads the instructions.
        await message.fill('Load `review-pr` first, then `/review-pr`, but not `missing-skill`.');
        await message.press('Enter');
        const reply = chat.locator('[data-agent-chat-reply]').filter({ hasText: 'missing-skill' });
        const skill = reply.getByRole('button', { name: 'Show $review-pr' });
        await expect(skill).toHaveCount(2);
        await expect(reply.locator('code', { hasText: 'missing-skill' })).toBeVisible();
        await skill.first().hover();
        const card = page.locator('[data-slot="hover-card-content"]');
        await expect(card.getByText('Review the open pull request')).toBeVisible();
        await expect(card.getByText('Review it.')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-inline-skill.png') });
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
        // Picked images are written into the message as placeholders; a file card is not.
        await expectComposerValue(
            message,
            `${shots.map((_, index) => `[Image #${index + 1}]`).join(' ')} `,
        );
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
        await expectComposerValue(message, /\[Long paste saved locally\]/u);
        const value = await composerValue(message);
        const savedPath = JSON.parse(/Original file: (".*")/u.exec(value)?.[1] ?? '""') as string;
        expect(await readFile(savedPath, 'utf8')).toBe(long);
        expect((await stat(savedPath)).mode & 0o777).toBe(0o600);
        expect(value).not.toContain('log line 1:');
        // The draft shows the saved paste as a chip while the text the Agent receives stays the note.
        await expect(message.locator('.cm-long-paste-chip')).toHaveText('Pasted text · 800 lines');
        await page.screenshot({ path: testInfo.outputPath('codex-chat-picked-files.png') });

        await message.press('Enter');
        await expect(chat.getByText(`Received ${shots.length} images.`)).toBeVisible();
        // The sent message shows what it cited as chips under its images instead of the reference block Codex got.
        const sent = chat.locator('[data-agent-chat-user-message]').last();
        await expect(sent).not.toContainText('Files mentioned by the user');
        await expect(sent).not.toContainText('Skills the user asked you to use');
        await expect(sent.locator('[data-agent-chat-long-paste]')).toHaveText(
            'Pasted text · 800 lines',
        );
        await expect(sent).not.toContainText('Long paste saved locally');
        // The skill leads the bubble's own text, so the message reads as one bubble rather than a chip row above it.
        await expect(
            sent.locator(
                '[data-agent-chat-user-bubble] [data-agent-chat-skill-reference="caxri-cli"]',
            ),
        ).toHaveText('Caxri skill');
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
        // The chip opens the saved original like a path link does.
        await expect(
            sent.getByRole('link', { name: /Saved paste: Pasted text · 800 lines/u }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-sent-files.png') });
        await expect(attached).toHaveCount(0);
        await expectComposerValue(message, '');
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
        await expect(message).toHaveAttribute('aria-placeholder', 'Message Claude');

        await pasteImage(message);
        await expect(chat.getByRole('button', { name: 'Remove screenshot.png' })).toBeVisible();
        // An image alone is a message.
        await message.press('Enter');
        await expect(chat.getByText('Received 1 image.')).toBeVisible();
        await expect(chat.getByRole('img', { name: 'Image 1' })).toBeVisible();
        await expect(chat.locator('[data-agent-chat-image-pill]')).toBeVisible();

        await message.fill('/');
        const commands = chat.getByRole('listbox', { name: 'Commands and skills' });
        // Commands that only make sense in Claude Code's own terminal UI (here /exit) are not offered.
        await expect(commands.getByRole('option')).toHaveText([
            ...BUILT_IN_COMMAND_ROWS,
            /^\/compact/u,
            /^\/review/u,
            /^\/goal/u,
        ]);
        await pressTimes(message, 'ArrowDown', BUILT_IN_COMMAND_ROWS.length + 1);
        await expect(commands.getByRole('option', { name: /^\/review/u })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await message.press('ArrowUp');
        await page.screenshot({ path: testInfo.outputPath('claude-chat-commands.png') });
        // /compact takes arguments, so Tab completes it instead of running it.
        await message.press('Tab');
        await expectComposerValue(message, '/compact ');
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
        const restored = chat.locator('img[alt="Image 1"]');
        await expect(restored).toHaveAttribute('src', /^data:image\/jpeg;base64,/u);
        await expect(restored).toHaveJSProperty('complete', true);
        await page.screenshot({ path: testInfo.outputPath('claude-chat-restored-image.png') });

        // A failed Hook's message reads as Markdown, so the command it quotes in backticks shows as code.
        await message.fill('synthetic feedback');
        await message.press('Enter');
        await expect(chat.locator('code', { hasText: 'example-check --config' })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-hook-feedback.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Chat recalls sent prompts from a list, stashes a draft with Ctrl+S, and clears it with Ctrl+C', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-history-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const bin = join(directory, 'bin');
    await mkdir(root, { recursive: true });
    await mkdir(bin, { recursive: true });
    // The pull request preview reads a token (`gh auth token`), then its REST read (`gh api repos/<owner>/<repo>/issues/<n>`)
    // answers with a merged pull request.
    await writeFile(
        join(bin, 'gh'),
        `#!/bin/sh
case " $* " in
  *" repos/acme/widgets/issues/7 "*) printf '%s' '{"number":7,"state":"closed","title":"Add widgets","html_url":"https://github.com/acme/widgets/pull/7","pull_request":{"merged_at":"2026-10-01T00:00:00Z"}}' ;;
  " auth token "*) printf '%s\n' 'fake-token' ;;
  *" api graphql -f "*) printf '%s' '{"data":{"rateLimit":{"limit":5000,"remaining":5000,"used":0,"resetAt":"2100-01-01T00:00:00Z"}}}' ;;
  *) exit 1 ;;
esac
`,
        'utf8',
    );
    await chmod(join(bin, 'gh'), 0o755);
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        const send = async (prompt: string): Promise<void> => {
            await message.fill(prompt);
            await message.press('Enter');
            await expectComposerValue(message, '');
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
        await expect(message).toHaveAttribute('aria-placeholder', 'first prompt');
        await message.press('ArrowUp');
        await expect(message).toHaveAttribute('aria-placeholder', 'second prompt');
        await page.screenshot({ path: testInfo.outputPath('chat-prompt-history.png') });
        // Enter fills the input without sending.
        await message.press('Enter');
        await expect(history).toHaveCount(0);
        await expectComposerValue(message, 'second prompt');
        await expect(chat.getByText('Hello from fake Codex. You said: second prompt')).toHaveCount(
            1,
        );

        // Escape closes the list and leaves the input empty; typing closes it and still types.
        await message.fill('');
        await message.press('ArrowUp');
        await expect(history).toBeVisible();
        await message.press('Escape');
        await expect(history).toHaveCount(0);
        await expectComposerValue(message, '');
        await message.press('ArrowUp');
        await message.press('x');
        await expect(history).toHaveCount(0);
        await expectComposerValue(message, 'x');

        // Ctrl+S sets a long draft aside so a quick question can go first, then brings it back after the send.
        await message.fill('a long draft to finish later');
        await message.press('Control+s');
        await expectComposerValue(message, '');
        await expect(message).toHaveAttribute(
            'aria-placeholder',
            'Draft stashed · Ctrl+S to restore',
        );
        await page.screenshot({ path: testInfo.outputPath('chat-draft-stashed.png') });
        await message.fill('quick question');
        await message.press('Enter');
        await expectComposerValue(message, 'a long draft to finish later');
        // Ctrl+S in an empty input restores a stash on demand too.
        await message.press('Control+s');
        await expectComposerValue(message, '');
        await message.press('Control+s');
        await expectComposerValue(message, 'a long draft to finish later');
        await expect(message).toHaveAttribute('aria-placeholder', 'Message Codex');

        // A pasted pull request link reads as it will once sent: its state glyph leads it and its text takes that tone.
        const link = 'https://github.com/acme/widgets/pull/7';
        await message.fill(`see ${link}`);
        await expect(chat.locator('.cm-web-link')).toHaveText(link);
        await expect(
            chat.locator('.cm-link-icon [data-pull-request-state="merged"]'),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('chat-composer-link.png') });
        // Ctrl+C over a selection stays Copy and leaves the draft alone.
        await message.press('Meta+a');
        await message.press('Control+c');
        await expectComposerValue(message, `see ${link}`);
        await message.press('End');
        // With nothing selected it empties the input as an ordinary edit, so Cmd+Z brings the text back.
        await message.press('Control+c');
        await expectComposerValue(message, '');
        await message.press('Meta+z');
        await expectComposerValue(message, `see ${link}`);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
