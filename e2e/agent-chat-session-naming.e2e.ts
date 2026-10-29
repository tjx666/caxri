import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeClaudeChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';

/**
 * Fake Claude reports a version that clears the low-cost generation minimum and answers `--print` with a fixed title,
 * so AI Session naming runs end to end without a host provider. The `ai-naming` control file opts in, and a
 * `naming-skip` of 2 spends one `SKIP` on the opening request and one on the completed turn's first sample, which the
 * completed turn resamples.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('AI naming titles a Claude Chat Session after a SKIP, and Rename Session with AI renames it again', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-naming-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const control = join(directory, 'control');
    await mkdir(root, { recursive: true });
    await mkdir(control, { recursive: true });
    const agentMode = await fakeClaudeChatAgentMode(userData, control);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const sessionId = await selectedSessionId(page);
        await writeFile(join(control, 'ai-naming'), '');
        await writeFile(join(control, 'naming-skip'), '2');
        const message = page.locator(VISIBLE_SESSION).getByRole('textbox', { name: 'Message' });
        await message.fill('hello there');
        await message.press('Enter');
        await expect(sessionCard(page, sessionId).locator('strong')).toHaveText(
            'Fake generated title',
            { timeout: 30_000 },
        );
        await page.screenshot({ path: testInfo.outputPath('ai-named.png') });

        // A manual name is replaced only after an explicit Rename Session with AI suggestion is accepted.
        const card = sessionCard(page, sessionId);
        await card.focus();
        await card.press('Enter');
        const input = card.getByRole('textbox');
        await input.fill('Manual name');
        await input.press('Enter');
        await expect(card.locator('strong')).toHaveText('Manual name');
        await page.keyboard.press('Meta+Shift+P');
        const palette = page.getByRole('dialog', { name: 'Command Palette' });
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Rename Session with AI');
        await palette.getByRole('option', { name: /^Rename Session with AI/ }).click();
        // The suggestion fills the inline editor; Enter accepts it.
        await expect(card.getByRole('textbox')).toHaveValue('Fake generated title', {
            timeout: 30_000,
        });
        await card.getByRole('textbox').press('Enter');
        await expect(card.locator('strong')).toHaveText('Fake generated title');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
