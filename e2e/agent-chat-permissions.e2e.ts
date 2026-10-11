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
test('a Codex Chat switches its permission level and plan mode, and a new Chat starts from the Project default', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-permissions-'));
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
        const picker = chat
            .getByRole('button', { name: /^Permissions: / })
            .filter({ visible: true });
        // Codex launches with its default autonomy flag, which is the Full access level.
        await expect(picker).toHaveAccessibleName('Permissions: Full access');

        await picker.click();
        const menu = page.getByRole('menu');
        // Codex offers its own presets only: no "Ask for approval" level.
        await expect(menu.getByRole('menuitemradio')).toHaveText([
            /Read only/,
            /Default/,
            /Auto/,
            /Full access/,
        ]);
        await menu.getByRole('menuitemradio', { name: /Read only/ }).click();
        await expect(picker).toHaveAccessibleName('Permissions: Read only');
        await menu.getByRole('menuitemcheckbox', { name: /Plan mode/ }).click();
        await expect(picker).toHaveAccessibleName('Permissions: Read only, plan mode on');
        await page.screenshot({ path: testInfo.outputPath('codex-chat-permission-menu.png') });
        await menu.getByRole('menuitem', { name: 'Use as Project default' }).click();
        await expect(menu.getByRole('menuitem', { name: 'Project default' })).toBeDisabled();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();

        // Sending works with plan mode on; the fake Codex app-server answers as usual.
        const message = chat.getByRole('textbox', { name: 'Message' }).filter({ visible: true });
        await message.fill('hello');
        await message.press('Enter');
        await expect(chat.getByText(/hello/u).filter({ visible: true }).first()).toBeVisible();

        await openAgentChat(page, 'Codex Chat');
        await expect(
            chat.getByRole('button', { name: /^Permissions: / }).filter({ visible: true }),
        ).toHaveAccessibleName('Permissions: Read only, plan mode on');
        await page.screenshot({ path: testInfo.outputPath('codex-chat-project-default.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
