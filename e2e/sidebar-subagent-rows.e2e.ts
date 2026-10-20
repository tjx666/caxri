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
