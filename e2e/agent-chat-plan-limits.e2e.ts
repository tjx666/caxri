import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UsageLimit } from '@caxri/protocol';

import { fakeClaudeChatAgentMode } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
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

        // Claude Code writes no limits into its transcript; the running Chat answered `/usage` for the status bar. The
        // chip leaves the 5-hour window out by default, and a week ahead of pace marks it as a warning that is dropped
        // last when the status bar runs out of room.
        const usageChip = page.getByRole('button', { name: /^Open Usage/u });
        await expect(usageChip).toContainText('wk 39% left');
        await expect(usageChip).not.toContainText('5h');
        await expect(usageChip).toHaveAttribute('data-status-urgent', '');
        await expect(usageChip).toHaveClass(/text-warning/u);

        const pace = chat.locator('[data-agent-chat-plan-pace-alert]');
        await expect(pace).toContainText(
            'Weekly limit on track to run out: 39% left, resets in 5d',
        );
        await page.screenshot({ path: testInfo.outputPath('claude-plan-pace-alert.png') });
        await pace.getByText(/^Weekly limit on track to run out/u).hover();
        await expect(page.locator('.tooltip-popup')).toContainText(
            'would still have about 73% left now',
        );

        await pace.getByRole('button', { name: 'Hide for today' }).click();
        await expect(pace).toHaveCount(0);
        await expect(message).toBeVisible();
        // The dismissal also acknowledges the chip's pace warning for today; 39% left is far from nearly spent.
        await expect(usageChip).not.toHaveClass(/text-warning/u);
        await expect(usageChip).not.toHaveAttribute('data-status-urgent', '');
        await expect(usageChip).toContainText('wk 39% left');

        // The Server keeps the dismissal, so the next poll does not bring the row back and a reloaded Renderer (as after
        // a restart, or another Client) reads it hidden too.
        await expect
            .poll(async () => {
                const limits = await pageRequest<UsageLimit[]>(page, 'usage.limits', {});
                return limits.find((limit) => limit.provider === 'claude')?.paceDismissedAt;
            })
            .toBeGreaterThan(0);
        await page.reload();
        await expect(usageChip).toContainText('wk 39% left');
        await expect(usageChip).not.toHaveClass(/text-warning/u);
        await expect(chat.getByRole('textbox', { name: 'Message' })).toBeVisible();
        await expect(pace).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
