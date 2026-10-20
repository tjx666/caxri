import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    VISIBLE_SESSION,
} from './support/helpers.ts';

/**
 * The Chat composer's `@` list offers a `Files` group of Project files beside the `Sessions` group
 * (`use-agent-chat-session-menu.ts`); the file search is the Server's name-mode `files.search`.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('typing @ in Agent Chat completes Project files and inserts a Project-relative path', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-file-mention-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(join(root, 'src', 'billing'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'src', 'billing', 'invoice-totals.ts'), 'export {};\n');
    await writeFile(join(root, 'docs', 'invoice notes.md'), '# notes\n');
    await writeFile(join(root, 'README.md'), '# project\n');
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        const citedId = await createProjectSession(page, 'shell');
        // A Session with an Agent conversation whose title also matches the typed word, so the Sessions group shows.
        await openAgentChat(page, 'Codex Chat');
        await pageRequest(page, 'session.rename', {
            sessionId: citedId,
            displayTitle: 'Invoice review plan',
        });
        const bootstrap = await pageRequest<BootstrapState>(page, 'app.bootstrap');
        const projectId = bootstrap.sessions.find((session) => session.id === citedId)?.projectId;
        const citing = await pageRequest<{ session: { id: string } }>(page, 'session.create', {
            projectId,
            defaultAgent: 'shell',
        });
        await pageRequest(page, 'session.select', { sessionId: citing.session.id });
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();

        await message.fill('read @invoice');
        const list = chat.getByRole('listbox', { name: 'Files and Sessions' });
        await expect(list.getByText('Files', { exact: true })).toBeVisible();
        await expect(list.getByText('Sessions', { exact: true })).toBeVisible();
        // Files come first in quick open's ranking (the shallower path leads an equal name match), then the Session.
        await expect(list.getByRole('option')).toHaveCount(3);
        await expect(list.getByRole('option').first()).toContainText('invoice notes.md');
        await expect(list.getByRole('option').nth(1)).toContainText('invoice-totals.ts');
        await expect(list.getByRole('option').nth(1)).toContainText('src/billing');
        await expect(list.getByRole('option').nth(2)).toContainText('Invoice review plan');
        await page.screenshot({ path: testInfo.outputPath('chat-file-mention.png') });

        // A path with whitespace is quoted so the mention does not end at the space.
        await message.press('Enter');
        await expect(list).toHaveCount(0);
        await expect(message).toHaveValue('read @"docs/invoice notes.md" ');

        await message.fill('@totals');
        await expect(list.getByRole('option')).toHaveCount(1);
        await expect(list.getByText('Sessions', { exact: true })).toHaveCount(0);
        await message.press('Tab');
        await expect(message).toHaveValue('@src/billing/invoice-totals.ts ');

        // A word nothing matches leaves the list closed, and Escape dismisses it until the next edit.
        await message.fill('@zzzz-no-such-file');
        await expect(list).toHaveCount(0);
        await message.fill('@readme');
        await expect(list).toBeVisible();
        await message.press('Escape');
        await expect(list).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
