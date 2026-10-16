import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { pasteAgentChatImage } from './support/agent-chat-image-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Chat recalls first-line history and restores a stashed input after restart', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-draft-stash-'));
    const directory = await realpath(created);
    const userDataDirectory = join(directory, 'profile');
    const testRootPath = join(directory, 'Example Project');
    await mkdir(testRootPath);
    try {
        const agentMode = await fakeCodexChatAgentMode(directory, userDataDirectory);
        const options = { agentMode, userDataDir: userDataDirectory, testRootPath };
        const first = await launchCaxri(options);
        try {
            await createProjectSession(first.page, 'shell');
            await openAgentChat(first.page, 'Codex Chat');
            const chat = first.page.locator(VISIBLE_SESSION);
            const message = chat.getByRole('textbox', { name: 'Message' });
            await message.fill('Example history prompt');
            await message.press('Enter');
            await expect(chat.getByText('Example history prompt', { exact: true })).toBeVisible();
            await expect(message).toHaveValue('');

            const draft = 'First example draft line\nSecond example draft line';
            await message.fill(draft);
            await message.press('ArrowUp');
            await expect(message).toHaveValue(draft);
            const returnCaret = await message.evaluate(
                (element) => (element as HTMLTextAreaElement).selectionStart,
            );
            await message.press('ArrowUp');
            await expect(message).toHaveValue('Example history prompt');
            await message.press('ArrowDown');
            await expect(message).toHaveValue(draft);
            await expect
                .poll(() =>
                    message.evaluate((element) => (element as HTMLTextAreaElement).selectionStart),
                )
                .toBe(returnCaret);

            const wrapped = 'Example wrapped input '.repeat(60);
            await message.fill(wrapped);
            await first.page.screenshot({ path: testInfo.outputPath('wrapped-before-up.png') });
            await message.press('ArrowUp');
            await first.page.screenshot({ path: testInfo.outputPath('wrapped-after-up.png') });
            await expect(message).toHaveValue(wrapped);
            const wrappedHistory = 'Example wrapped history '.repeat(12).trim();
            await message.fill(wrappedHistory);
            await chat.getByRole('button', { name: 'Send', exact: true }).click();
            await expect(
                chat.getByText(`Hello from fake Codex. You said: ${wrappedHistory.trim()}`, {
                    exact: true,
                }),
            ).toBeVisible();
            await message.fill('Example return draft');
            await message.press('ArrowUp');
            await expect(message).toHaveValue(wrappedHistory.trim());
            await first.page.screenshot({
                path: testInfo.outputPath('wrapped-history-recalled.png'),
            });
            await message.evaluate((element) =>
                (element as HTMLTextAreaElement).setSelectionRange(0, 0),
            );
            await message.press('ArrowDown');
            await expect(message).toHaveValue(wrappedHistory.trim());
            await message.evaluate((element) => {
                const input = element as HTMLTextAreaElement;
                input.setSelectionRange(input.value.length, input.value.length);
            });
            await message.press('ArrowDown');
            await expect(message).toHaveValue('Example return draft');
            await message.fill(draft);

            await pasteAgentChatImage(message);
            await expect(chat.getByRole('button', { name: 'Remove screenshot.png' })).toBeVisible();
            await chat.getByRole('button', { name: 'Add files and more' }).click();
            await first.page.getByRole('menuitem', { name: /^Goal/u }).click();
            await expect(first.page.getByRole('menuitem', { name: /^Goal/u })).toBeHidden();
            const goalChip = chat.getByRole('button', {
                name: 'Goal mode',
                exact: true,
                pressed: true,
            });
            await expect(goalChip).toBeVisible();
            await message.evaluate((element) => {
                (element as HTMLTextAreaElement).setSelectionRange(4, 9, 'backward');
            });
            await first.page.screenshot({ path: testInfo.outputPath('draft-before-stash.png') });
            await message.press('Control+s');
            await expect(message).toHaveValue('');
            await expect(goalChip).toHaveCount(0);
            await expect(chat.getByRole('button', { name: 'Remove screenshot.png' })).toHaveCount(
                0,
            );
            await first.page.screenshot({ path: testInfo.outputPath('draft-stashed.png') });
        } finally {
            await closeAppQuietly(first.app);
        }

        const restarted = await launchCaxri(options);
        try {
            const chat = restarted.page.locator(VISIBLE_SESSION);
            const message = chat.getByRole('textbox', { name: 'Message' });
            await expect(message).toHaveValue('');
            await message.press('Control+s');
            await expect(message).toHaveValue(
                'First example draft line\nSecond example draft line',
            );
            await expect(chat.getByRole('button', { name: 'Remove screenshot.png' })).toBeVisible();
            await expect(
                chat.getByRole('button', { name: 'Goal mode', exact: true, pressed: true }),
            ).toBeVisible();
            await expect
                .poll(() =>
                    message.evaluate((element) => {
                        const input = element as HTMLTextAreaElement;
                        return {
                            start: input.selectionStart,
                            end: input.selectionEnd,
                            direction: input.selectionDirection,
                        };
                    }),
                )
                .toEqual({ start: 4, end: 9, direction: 'backward' });
            await restarted.page.screenshot({
                path: testInfo.outputPath('draft-restored-after-restart.png'),
            });
        } finally {
            await closeAppQuietly(restarted.app);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
