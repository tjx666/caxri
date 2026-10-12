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
 * A Chat transcript selects only message text. Dragging from the user's message to the reply's time holds both
 * messages' text and none of the transcript chrome, and releasing it floats Copy and Add to message over the selection:
 * Copy confirms in place rather than with a toast, and Add to message quotes the selection into the draft.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Chat selects only message text and offers Copy and Add to message', async ({}, testInfo) => {
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
        // The reply's action row, chrome under the reply text that a selectable transcript would take along. It mounts
        // only while the reply is hovered.
        await reply.hover();
        const time = chat.locator('[data-agent-chat-reply] time');
        const timeText = (await time.textContent()) ?? '';
        expect(timeText).not.toBe('');

        const start = await chat.getByText('hi there', { exact: true }).boundingBox();
        const end = await time.boundingBox();
        if (!start || !end) throw new Error('Chat messages are not laid out');
        // Inside the bubble's text, past its 12px padding: a press on the padding alone starts no selection.
        await page.mouse.move(start.x + 14, start.y + start.height / 2);
        await page.mouse.down();
        await page.mouse.move(end.x + end.width - 2, end.y + end.height / 2, { steps: 12 });
        await page.mouse.up();
        const selected = await page.evaluate(() => getSelection()?.toString() ?? '');
        expect(selected).toContain('hi there');
        expect(selected).toContain('Hello from fake Codex. You said: hi there');
        expect(selected).not.toContain(timeText);

        const toolbar = page.getByRole('toolbar', { name: 'Selection actions' });
        await expect(toolbar).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-selection-toolbar.png') });

        // Copy writes through a stubbed clipboard, so the run never overwrites the developer's system clipboard.
        await page.evaluate(() => {
            const target = globalThis as typeof globalThis & { __copiedText?: string };
            navigator.clipboard.writeText = (text) => {
                target.__copiedText = text;
                return Promise.resolve();
            };
        });
        await toolbar.getByRole('button', { name: 'Copy' }).click();
        await expect(toolbar.getByRole('button', { name: 'Copied' })).toBeVisible();
        const copied = await page.evaluate(
            () => (globalThis as typeof globalThis & { __copiedText?: string }).__copiedText,
        );
        expect(copied).toBe(selected.trimEnd());
        await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

        await toolbar.getByRole('button', { name: 'Add to message' }).click();
        await expect(toolbar).toBeHidden();
        await expect(message).toBeFocused();
        // Every line of the selection is quoted, ending with the reply's text, and the caret waits on a new paragraph.
        const draft = await message.inputValue();
        expect(draft.endsWith('\n\n')).toBe(true);
        expect(
            draft
                .trimEnd()
                .split('\n')
                .every((line) => line.startsWith('>')),
        ).toBe(true);
        expect(draft).toMatch(/^> (hi )?there\n/);
        expect(draft).toMatch(/> Hello from fake Codex\. You said: hi there\n\n$/);
        expect(await message.evaluate((input: HTMLTextAreaElement) => input.selectionStart)).toBe(
            draft.length,
        );
        await page.screenshot({ path: testInfo.outputPath('agent-chat-selection-quoted.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
