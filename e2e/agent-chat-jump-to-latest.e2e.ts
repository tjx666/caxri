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
