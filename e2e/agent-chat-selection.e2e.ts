import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

/**
 * A Chat transcript selects only message text. Dragging from the user's message to the end of the reply holds both
 * messages' text and none of the transcript chrome between them, and copying it confirms with a toast. The copy event
 * is dispatched rather than sent as Cmd+C, so the run never overwrites the developer's system clipboard.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Chat selects and copies only message text', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-selection-'));
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
        await message.fill('hi there');
        await message.press('Enter');
        const reply = chat.getByText('Hello from fake Codex. You said: hi there', { exact: true });
        await expect(reply).toBeVisible();
        // The finished turn's "Worked" fold sits between the two messages.
        await expect(chat.getByRole('button', { name: /^Worked(?: for |$)/u })).toBeVisible();

        const start = await chat.getByText('hi there', { exact: true }).boundingBox();
        const end = await reply.boundingBox();
        if (!start || !end) throw new Error('Chat messages are not laid out');
        // Inside the bubble's text, past its 12px padding: a press on the padding alone starts no selection.
        await page.mouse.move(start.x + 14, start.y + start.height / 2);
        await page.mouse.down();
        await page.mouse.move(end.x + end.width - 2, end.y + end.height / 2, { steps: 12 });
        await page.mouse.up();
        const selected = await page.evaluate(() => getSelection()?.toString() ?? '');
        expect(selected).toContain('hi there');
        expect(selected).toContain('Hello from fake Codex. You said: hi there');
        expect(selected).not.toContain('Worked');

        await reply.dispatchEvent('copy', { bubbles: true });
        const toast = page.locator('[data-sonner-toast][data-type="success"]', {
            hasText: 'Selection copied',
        });
        await expect(toast).toBeVisible();
        // Sonner slides the toast in; wait out the entrance so the screenshot shows it rather than its first frame.
        await expect.poll(() => toast.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-selection-copied.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
