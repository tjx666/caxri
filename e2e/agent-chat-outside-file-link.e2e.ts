import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture';
import { allowE2EErrors, expect, test } from './support/fixtures';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers';

/**
 * An Agent that writes a file outside every Project and cites it by name alone: the Project-scoped lookup finds
 * nothing, so the Chat opens the one file of that name its own work wrote instead of reporting it missing.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a file the Agent wrote outside the Project opens from its bare cited name', async ({}, testInfo) => {
    // The bare name first misses every Project, the way it did before the fallback existed.
    allowE2EErrors([
        { source: 'server-core', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'caxri-outside-file-link-'));
    const root = join(directory, 'project');
    const userData = join(directory, 'profile');
    await mkdir(root);
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { app, page } = running;
        // Confirm the one-time "open a file outside your Projects" prompt.
        await app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);
        const message = session.getByRole('textbox', { name: 'Message' });
        await message.fill('outsidefile');
        await message.press('Enter');
        const cited = session.getByRole('button', { name: 'launch-plan.md', exact: true });
        await expect(cited).toBeVisible();
        await cited.click();
        await expect(page.getByRole('tab', { name: 'launch-plan.md' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(page.locator('.monaco-editor .view-lines')).toContainText('# Launch plan');
        await page.screenshot({ path: testInfo.outputPath('outside-file-opened.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
