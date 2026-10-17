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
test('Markdown Copy controls appear on hover and remain accessible by keyboard', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-markdown-copy-'));
    const directory = await realpath(created);
    const userDataDirectory = join(directory, 'profile');
    const testRootPath = join(directory, 'Example Project');
    await mkdir(testRootPath);
    const agentMode = await fakeCodexChatAgentMode(directory, userDataDirectory);
    const running = await launchCaxri({ agentMode, userDataDir: userDataDirectory, testRootPath });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION).getByRole('region', { name: 'Codex' });
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('table');
        await message.press('Enter');
        const heading = chat.getByRole('heading', { name: 'Summary', level: 2 });
        const code = chat.getByRole('button', { name: 'Copy code', exact: true });
        const table = chat.getByRole('button', { name: 'Copy table', exact: true });
        await heading.hover();
        await expect(code).toHaveCSS('opacity', '0');
        await expect(table).toHaveCSS('opacity', '0');
        await page.screenshot({ path: testInfo.outputPath('copy-controls-default.png') });
        await code.locator('..').hover();
        await expect(code).toHaveCSS('opacity', '1');
        await expect(table).toHaveCSS('opacity', '0');
        await page.screenshot({ path: testInfo.outputPath('copy-code-hover.png') });
        await table.locator('..').hover();
        await expect(table).toHaveCSS('opacity', '1');
        await expect(code).toHaveCSS('opacity', '0');
        await page.screenshot({ path: testInfo.outputPath('copy-table-hover.png') });
        await code.focus();
        await heading.hover();
        await expect(code).toHaveCSS('opacity', '1');
        await page.screenshot({ path: testInfo.outputPath('copy-code-keyboard.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
