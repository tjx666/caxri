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

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test("a running Claude Chat reports its plan's 5-hour and weekly limits and warns when the week runs ahead of pace", async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-claude-plan-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const control = join(directory, 'control');
    await mkdir(root, { recursive: true });
    await mkdir(control, { recursive: true });
    // The fake's `/usage` answer: 5-hour 22% used, weekly 61% used with 5 days 3 hours to go (an even pace leaves 73%).
    await writeFile(join(control, 'plan-behind-pace'), '');
    const agentMode = await fakeClaudeChatAgentMode(userData, control);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        const terminalMenu = page.getByRole('menu', { name: 'New Terminal' });
        await terminalMenu.getByRole('menuitemcheckbox', { name: 'Open Agents in Chat' }).click();
        await chooseTerminalFromCreateMenu(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toHaveAttribute('aria-placeholder', 'Message Claude');
        await expect(
            chat.getByRole('button', { name: 'Model: Default, Medium effort', exact: true }),
        ).toBeVisible();
        await message.fill('hi there');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Claude. You said: hi there')).toBeVisible();

        // Claude Code writes no limits into its transcript; the running Chat answered `/usage` for the status bar.
        const usageChip = page.getByRole('button', { name: /^Open Usage/u });
        await expect(usageChip).toContainText('5h 78% · 7d 39% left');

        const pace = chat.locator('[data-agent-chat-plan-pace-alert]');
        await expect(pace).toContainText('Weekly limit ahead of pace: 39% left, resets in 5d');
        await page.screenshot({ path: testInfo.outputPath('claude-plan-pace-alert.png') });
        await pace.getByText(/^Weekly limit ahead of pace/u).hover();
        await expect(page.locator('.tooltip-popup')).toContainText('would leave about 73% now');

        await pace.getByRole('button', { name: 'Hide for today' }).click();
        await expect(pace).toHaveCount(0);
        await expect(message).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
