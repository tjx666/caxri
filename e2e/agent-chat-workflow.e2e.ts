import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openBackgroundWork } from './support/agent-chat-background-work.ts';
import { fakeClaudeChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat follows a workflow run by phase, opens a member, and stops the run', async ({}, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-claude-workflow-'));
    const directory = await realpath(temporary);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });

        // A run that keeps going: the strip counts the running phase.
        await message.fill('start a workflow');
        await message.press('Enter');
        const strip = await openBackgroundWork(chat);
        const open = strip.getByRole('button', { name: /^Open review/u });
        await expect(open).toBeVisible();
        await expect(strip.getByText('Review 0/2')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('workflow-strip.png') });

        await open.click();
        const tab = page.getByRole('region', { name: 'review' });
        await expect(tab.getByText('1/3 subagents').filter({ visible: true })).toBeVisible();
        // The finished phase collapses to one row; the running one lists its members, the queued one waiting.
        await expect(tab.getByRole('button', { name: 'Expand Inspect' })).toBeVisible();
        await expect(tab.getByRole('button', { name: 'Collapse Review' })).toBeVisible();
        await expect(tab.getByText('Queued, starts when a slot frees up')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('workflow-tab-running.png') });

        const member = tab.getByRole('button', { name: 'Open review:correctness' });
        await member.click();
        await expect(tab.getByText('No correctness issues found.').first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('workflow-member.png') });
        await tab.getByRole('button', { name: 'Previous subagent' }).click();
        await expect(tab.getByText('Layout is consistent.').first()).toBeVisible();
        await tab.getByRole('button', { name: 'Next subagent' }).click();
        await tab.getByRole('button', { name: 'Back to Workflow' }).click();
        // Back returns focus to the member that was open.
        await expect(member).toBeFocused();

        await tab.getByRole('button', { name: 'Stop workflow' }).click();
        await expect(tab.getByRole('button', { name: 'Stop workflow' })).toHaveCount(0);
        await expect(
            tab
                .getByText(/2 interrupted/u)
                .filter({ visible: true })
                .first(),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('workflow-stopped.png') });

        // A run that finishes with a failed member pins its result and names the failure.
        await message.fill('quick workflow');
        await message.press('Enter');
        // The stopped run's tab stays open under the same name; the finished run's tab is the one with a result.
        const done = page
            .getByRole('region', { name: 'review' })
            .filter({ has: page.getByText('Result', { exact: true }) });
        await (
            await openBackgroundWork(chat)
        )
            .getByRole('button', { name: /^Open review/u })
            .first()
            .click();
        await expect(done.getByText('One member failed', { exact: false })).toBeVisible();
        await expect(
            done
                .getByText(/1 failed/u)
                .filter({ visible: true })
                .first(),
        ).toBeVisible();
        await expect(done.getByText('Read failed: permission denied')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('workflow-completed.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
