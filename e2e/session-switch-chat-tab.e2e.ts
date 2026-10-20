import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeClaudeChatAgentMode } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';

/**
 * Coming back to a Session lands on the tab that was active when the user left, even when that tab is a Chat opened
 * after a file (issue #1824).
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('switching back to a Session restores its active Chat tab', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-session-chat-tab-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'README.md'), '# Fixture\n', 'utf8');
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        const firstSessionId = await selectedSessionId(page);
        const session = page.locator(VISIBLE_SESSION);
        await session.getByRole('button', { name: 'New Terminal' }).click();
        await page
            .getByRole('menu', { name: 'New Terminal' })
            .getByRole('menuitemcheckbox', { name: 'Open Agents in Chat' })
            .click();
        await chooseTerminalFromCreateMenu(page, 'Claude Chat');
        const message = session.getByRole('textbox', { name: 'Message' });
        await expect(
            session.getByRole('button', { name: 'Model: Default, Medium effort', exact: true }),
        ).toBeVisible();
        await message.fill('hi there');
        await message.press('Enter');
        await expect(session.getByText('Hello from fake Claude. You said: hi there')).toBeVisible();

        await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
        const readme = session.getByRole('tab', { name: 'README.md' });
        await expect(readme).toHaveAttribute('aria-selected', 'true');
        const chatTab = session.getByRole('tab', { name: /^Claude/u });
        await chatTab.click();
        await expect(chatTab).toHaveAttribute('aria-selected', 'true');
        await expect(message).toBeVisible();

        await createAdditionalShellSession(page);
        await sessionCard(page, firstSessionId).click();
        await expect.poll(() => selectedSessionId(page)).toBe(firstSessionId);
        await page.screenshot({ path: testInfo.outputPath('session-switch-chat-tab.png') });
        await expect(chatTab).toHaveAttribute('aria-selected', 'true');
        await expect(readme).toHaveAttribute('aria-selected', 'false');
        await expect(message).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
