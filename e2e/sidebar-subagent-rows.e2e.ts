import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings } from '@caxri/protocol';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    VISIBLE_SESSION,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Chat subagent shows as a child row under its Session, opens its task, and hides with the setting', async ({}, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-sidebar-subagents-'));
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
        await message.fill('start a subagent hold');
        await message.press('Enter');

        const row = page.getByRole('treeitem', { name: /^Subagent Inspect the fixtures/u });
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute('aria-level', '3');
        await page.screenshot({ path: testInfo.outputPath('sidebar-subagent-row.png') });

        await row.click();
        await expect(page.getByRole('region', { name: /Inspect the fixtures/u })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('sidebar-subagent-opened.png') });

        const current = await pageRequest<{ value: AppSettings }>(page, 'settings.get');
        const settings = structuredClone(current.value);
        settings['primarySidebar.showSubagents'] = false;
        await pageRequest(page, 'settings.update', { source: JSON.stringify(settings, null, 2) });
        await expect(row).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the subagent show-more row unfolds the rest below itself and folds them again in place', async ({}, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-sidebar-subagent-toggle-'));
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
        const subagentRows = page.locator('.subagent-list [role="treeitem"]');
        // Four subagents, one more than the folded window shows.
        for (let count = 1; count <= 4; count += 1) {
            // eslint-disable-next-line no-await-in-loop -- one turn at a time: each message waits for the last to end
            await message.fill(`start a subagent ${count}`);
            // eslint-disable-next-line no-await-in-loop -- one turn at a time: each message waits for the last to end
            await message.press('Enter');
            // eslint-disable-next-line no-await-in-loop -- one turn at a time: each message waits for the last to end
            await expect(page.locator('.subagent-list [data-subagent-status]')).toHaveCount(
                Math.min(count, 3),
            );
            // eslint-disable-next-line no-await-in-loop -- one turn at a time: each message waits for the last to end
            await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        }

        const toggle = page.getByRole('treeitem', { name: 'Show more subagents (1 hidden)' });
        await expect(subagentRows).toHaveCount(4);
        await expect(subagentRows.nth(3)).toHaveAttribute('data-subagent-toggle', 'folded');
        await expect(page.locator('.subagent-guide')).toHaveCount(1);
        await page
            .getByRole('tree')
            .first()
            .screenshot({
                path: testInfo.outputPath('subagent-rows-folded.png'),
            });

        await toggle.click();
        const fold = page.getByRole('treeitem', { name: 'Show fewer subagents' });
        await expect(subagentRows).toHaveCount(5);
        // The toggle stays where the folded list ended, so the pointer that unfolded it can fold it again.
        await expect(subagentRows.nth(3)).toHaveAttribute('data-subagent-toggle', 'expanded');
        await expect(subagentRows.nth(4)).toHaveAttribute('data-subagent-status', /.+/u);
        await page
            .getByRole('tree')
            .first()
            .screenshot({
                path: testInfo.outputPath('subagent-rows-expanded.png'),
            });

        // Arrow keys walk the rows in screen order: the toggle, then the subagent unfolded below it.
        await fold.focus();
        await page.keyboard.press('ArrowDown');
        await expect(subagentRows.nth(4)).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(fold).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(subagentRows).toHaveCount(4);
        await expect(toggle).toBeFocused();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
