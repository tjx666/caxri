import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeCodexChatAgentMode } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

test('typing after a reload continues the restored Chat draft without opening the Sessions list', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-draft-caret-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        const terminalMenu = page.getByRole('menu', { name: 'New Terminal' });
        await terminalMenu.getByRole('menuitemcheckbox', { name: 'Open Agents in Chat' }).click();
        await chooseTerminalFromCreateMenu(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        const sessions = chat.getByRole('listbox', { name: 'Sessions' });
        // A draft that ends in `@word`: the restored composer must not open the Sessions list on its own (#1699).
        const draft = 'Please compare with @thr';
        await message.fill(draft);

        await page.reload();
        await expect(message).toHaveValue(draft);
        await expect(message).toBeFocused();
        await expect(sessions).toHaveCount(0);
        await page.keyboard.type(' Hi');
        await expect(message).toHaveValue(`${draft} Hi`);
        await expect(sessions).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
