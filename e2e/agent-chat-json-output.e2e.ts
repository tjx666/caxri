import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectDisclosuresSettled } from './support/agent-chat-disclosures.ts';
import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture';
import { expect, test } from './support/fixtures';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a command printing one-line JSON shows it indented (#3184)', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-json-output-'));
    const root = join(directory, 'project');
    const userData = join(directory, 'profile');
    await mkdir(root);
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);
        const message = session.getByRole('textbox', { name: 'Message' });
        await message.fill('jsonout');
        await message.press('Enter');
        await expect(session.getByText('Found two repositories.')).toBeVisible();
        await expect(session.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        const fold = session.getByRole('button', { name: /^Worked(?: for |$)/u }).last();
        if ((await fold.count()) > 0 && (await fold.getAttribute('aria-expanded')) === 'false')
            await fold.click();
        const row = session
            .locator('[data-agent-chat-work-item]')
            .filter({ hasText: 'gh search repos' })
            .last();
        await row.getByRole('button').first().click();
        // The fixture prints `{"fullName":"owner/example",...}`; only the indented layout puts a space after the colon.
        await expect(row).toContainText('"fullName": "owner/example"');
        await expect(row).toContainText('"topics": []');
        await expectDisclosuresSettled(session, 'agent-chat-item');
        await page.screenshot({ path: testInfo.outputPath('json-output-indented.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
