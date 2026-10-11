import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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
test('a Codex Chat open in another Codex client says so and resumes once released', async ({}, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-in-use-'));
    const directory = await realpath(temporary);
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
        await message.fill('first');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Codex. You said: first')).toBeVisible();

        // Another client takes the thread's writer, as the Codex app does when it opens the same conversation.
        const threads = join(directory, 'codex-threads');
        const thread = (await readdir(threads)).find((name) => name.endsWith('.json'));
        if (!thread) throw new Error('The fake Codex saved no thread');
        const writerLock = join(threads, thread.replace(/\.json$/u, '.writer-held'));
        await writeFile(writerLock, '');

        // The crash forces a resume, which the held writer refuses.
        await message.fill('crash now');
        await message.press('Enter');
        const crashed = chat.getByRole('alert').filter({ hasText: 'Codex stopped unexpectedly' });
        await expect(crashed).toBeVisible();
        await crashed.getByRole('button', { name: 'Retry' }).click();
        const inUse = chat.getByRole('alert').filter({
            hasText: 'This conversation is open in another Codex app or window.',
        });
        await expect(inUse).toBeVisible();
        await expect(inUse).toContainText('Another Codex client is using this conversation');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-conversation-in-use.png') });

        // Closing it in the other client and retrying resumes the same conversation here.
        await rm(writerLock);
        await inUse.getByRole('button', { name: 'Retry' }).click();
        await expect(inUse).toHaveCount(0);
        await expect(chat.getByText('Hello from fake Codex. You said: first')).toBeVisible();
        await message.fill('back again');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Codex. You said: back again')).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
