import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeClaudeChatAgentMode } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';
import { setOpenAgentsIn } from './support/open-agents-in.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Chat compacting before it reads a message shows the compaction where the reply will be', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-chat-compaction-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const control = join(directory, 'control');
    await mkdir(root, { recursive: true });
    await mkdir(control, { recursive: true });
    const hold = join(control, 'hold-compaction');
    await writeFile(hold, '');
    const agentMode = await fakeClaudeChatAgentMode(userData, control);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        await setOpenAgentsIn(page.getByRole('menu', { name: 'New Terminal' }), 'Chat');
        await chooseTerminalFromCreateMenu(page, 'Claude Chat');

        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('compact first, then merge');
        await message.press('Enter');

        // The fake compacts before it reads the message: the timeline holds the reply's place with the compaction, how
        // long it has run, and that the message is read once it ends, instead of a blank page under the prompt.
        const compacting = chat.locator('[data-agent-chat-compacting]');
        await expect(compacting).toContainText('Compacting context…');
        await expect(compacting).toContainText('The Agent picks up your message once it finishes');
        await expect(compacting.locator('[data-agent-chat-elapsed-time]')).toBeVisible();
        await expect(
            chat.locator('[data-agent-chat-status-row="activity"] [data-agent-chat-elapsed-time]'),
        ).toBeVisible();
        await expect(chat.locator('[data-agent-chat-reply-placeholder]')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('chat-compacting.png') });

        await rm(hold);
        // The compacted divider takes the row's place, and the Agent then answers the message.
        await expect(chat.locator('[data-agent-chat-compacted]')).toBeVisible();
        await expect(chat.getByText('Picked up your message after compacting.')).toBeVisible();
        await expect(compacting).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('chat-compacted.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { force: true, recursive: true });
    }
});
