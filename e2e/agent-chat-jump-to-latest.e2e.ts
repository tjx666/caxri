import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Jump to latest shows only while the latest turn is out of view, not over the space kept below it', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-jump-'));
    const directory = await realpath(created);
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
        const transcript = chat.getByRole('log');
        // The control stays mounted to animate; while hidden it is `inert`, so only a live one counts.
        const jump = chat.locator('button:not([inert])', { hasText: 'Jump to latest' });

        // Two long replies first, so the history above the latest turn is taller than the view.
        await message.fill('table please');
        await message.press('Enter');
        await expect(chat.getByRole('table')).toHaveCount(1);
        await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0);
        await message.fill('table please');
        await message.press('Enter');
        await expect(chat.getByRole('table')).toHaveCount(2);
        await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0);
        // Sent from the end, a message keeps following even when scroll anchoring nudges the view as it renders.
        await expect(jump).toHaveCount(0);
        await message.fill('short one');
        await message.press('Enter');
        await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0);
        await expect(jump).toHaveCount(0);

        // Like the Codex app, the sent message rests below the view's top, leaving the previous reply's tail in view.
        const sent = transcript.getByText('short one', { exact: true });
        await expect
            .poll(() =>
                sent.evaluate((element) => {
                    const view = element.closest('[role="log"]');
                    if (!view) return NaN;
                    return element.getBoundingClientRect().top - view.getBoundingClientRect().top;
                }),
            )
            .toBeGreaterThan(100);
        await page.screenshot({ path: testInfo.outputPath('sent-message-top-gap.png') });

        // The short latest turn rests at the top with empty space below it; scrolling up a little keeps it in view.
        await transcript.hover();
        const endTop = await transcript.evaluate((element) => element.scrollTop);
        await page.mouse.wheel(0, -120);
        await expect
            .poll(() => transcript.evaluate((element) => element.scrollTop))
            .toBeLessThan(endTop - 60);
        await page.waitForTimeout(400);
        await page.screenshot({ path: testInfo.outputPath('latest-turn-in-view.png') });
        await expect(jump).toHaveCount(0);

        // Reading from the top puts the latest turn below the view, so the control appears and brings it back.
        await transcript.evaluate((element) => {
            element.scrollTop = 0;
        });
        await expect(jump).toBeVisible();
        await jump.click();
        await expect(jump).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('A message sent while reading above the end still rises to the top', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-rise-'));
    const directory = await realpath(created);
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
        const transcript = chat.getByRole('log');
        const jump = chat.locator('button:not([inert])', { hasText: 'Jump to latest' });

        await message.fill('table please');
        await message.press('Enter');
        await expect(chat.getByRole('table')).toHaveCount(1);
        await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0);
        await message.fill('table please');
        await message.press('Enter');
        await expect(chat.getByRole('table')).toHaveCount(2);
        await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0);

        // Scrolled up a little to reread the long reply, so sending is what brings the view back to the end.
        await transcript.evaluate((element) => {
            element.scrollTop -= 200;
        });
        await expect(jump).toBeVisible();
        await message.fill('short one');
        await message.press('Enter');
        // The reply proves the provider's message replaced the pending row, so the check covers the settled turn.
        await expect(transcript.getByText('You said: short one')).toBeVisible();
        await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0);

        const sent = transcript.getByText('short one', { exact: true });
        await expect
            .poll(() =>
                sent.evaluate((element) => {
                    const view = element.closest('[role="log"]');
                    if (!view) return NaN;
                    return element.getBoundingClientRect().top - view.getBoundingClientRect().top;
                }),
            )
            .toBeLessThan(200);
        await page.screenshot({ path: testInfo.outputPath('sent-from-history-rises.png') });
        await expect(jump).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
