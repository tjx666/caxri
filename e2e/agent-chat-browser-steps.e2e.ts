import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
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

/**
 * Claude Code drives Chrome through `mcp__claude-in-chrome__*` tools. The Chat shows those calls the way it shows a
 * Codex browser step: a globe, a title naming what the step did, and a work group counting browser steps.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Code Chrome call reads as a titled browser step', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-claude-browser-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeClaudeChatAgentMode(userData);
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
        // The effort shows once Claude Code has started, so Enter below sends instead of racing the launch.
        await expect(
            chat.getByRole('button', { name: 'Model: Default, Medium effort', exact: true }),
        ).toBeVisible();
        await message.fill('use chrome');
        await message.press('Enter');
        await expect(chat.getByText('Checked the settings page.')).toBeVisible();
        await chat
            .getByRole('button', { name: /^Worked(?: for |$)/u })
            .last()
            .click();
        await chat.getByRole('button', { name: /^Ran 3 browser steps, 1 failed/u }).click();
        await expect(chat.getByText(/claude-in-chrome/u)).toHaveCount(0);
        await expect(chat.getByRole('button', { name: /^Click ref_12/u })).toBeVisible();
        await expect(
            chat.getByRole('button', { name: /^Failed: Find Export button/u }),
        ).toBeVisible();
        // The expanded step shows its arguments and output.
        const openStep = chat.getByRole('button', {
            name: /^Open https:\/\/example\.test\/settings/u,
        });
        await openStep.click();
        // A JSON object argument reads as a name and value list, not one line of JSON.
        await expect(chat.getByRole('term').filter({ hasText: /^url$/u })).toBeVisible();
        await expect(
            chat
                .getByRole('definition')
                .filter({ hasText: /^https:\/\/example\.test\/settings$/u }),
        ).toBeVisible();
        await expect(chat.getByRole('definition').filter({ hasText: /^1$/u })).toBeVisible();
        await expect(chat.getByText('Navigated to https://example.test/settings')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-browser-steps.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
