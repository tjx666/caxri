import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectComposerValue } from './support/agent-chat-composer.ts';
import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

/**
 * A Files entry dropped into the Chat composer is cited by its absolute path and drawn as a pill with its icon and name
 * (`agent-chat-path-pills.ts`). The drop carries the same types the Files tree's `startFilePathDrag` writes.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Files folder dropped into Agent Chat shows as a pill, keeps its absolute path, and stays a pill once sent', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-path-pill-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const hooks = join(root, '.githooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\n');
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        await message.fill('look at');
        await message.press('End');

        await message.evaluate((element, path) => {
            const dataTransfer = new DataTransfer();
            dataTransfer.setData('application/x-caxri-file-path', path);
            dataTransfer.setData('application/x-caxri-path-is-directory', '1');
            for (const type of ['dragenter', 'dragover', 'drop'])
                element.dispatchEvent(
                    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
                );
        }, hooks);

        // A folder's path ends in `/`, which is how the sent message still knows to draw a folder.
        await expectComposerValue(message, `look at ${hooks}/ `);
        const pill = chat.locator('.cm-path-pill');
        await expect(pill).toHaveText('.githooks');
        await expect(pill).toHaveAttribute('title', hooks);
        await expect(pill.locator('img')).toHaveAttribute('src', /folder/u);
        await chat.screenshot({ path: testInfo.outputPath('chat-path-pill.png') });

        // The draft outlives the composer; its dropped path comes back as a pill, not a raw path.
        await page.getByRole('button', { name: 'Terminal', exact: true }).click();
        await page.getByRole('button', { name: 'Chat', exact: true }).click();
        await expect(pill).toHaveText('.githooks');
        await expectComposerValue(message, `look at ${hooks}/ `);
        await message.press('End');

        await message.press('Enter');
        const sent = chat.locator(`[data-agent-chat-path-pill="${hooks}"]`);
        await expect(sent).toHaveText('.githooks');
        await expect(sent.locator('img')).toHaveAttribute('src', /folder/u);
        await expect(chat.getByText(`You said: look at ${hooks}/`)).toBeVisible();
        await chat.screenshot({ path: testInfo.outputPath('chat-path-pill-sent.png') });

        // A typed folder path has no trailing `/`; the Server still says it names a folder inside the Project.
        // The Project stores the canonical root (`/private/var/...` on macOS), so type that form.
        const canonicalRoot = await realpath(root);
        await message.fill(`check ${canonicalRoot}`);
        await message.press('Enter');
        const typed = chat.locator(`[data-agent-chat-path-pill="${canonicalRoot}"]`);
        await expect(typed).toHaveText('project');
        await expect(typed.locator('img')).toHaveAttribute('src', /folder/u);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
