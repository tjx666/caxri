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
test('an approval or question card is the waiting state, set like the Codex app', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-request-cards-'));
    const directory = await realpath(created);
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
        const stripRows = chat.locator('[data-agent-chat-composer-strip-row]');

        await message.fill('please approve this');
        await message.press('Enter');
        const approval = chat.getByRole('region', { name: 'Run this command?' });
        await expect(approval).toContainText('echo approved');
        // The command is painted with the editor's colors, as it is on a work row.
        await expect(approval.locator('pre code span').first()).toBeVisible();
        // The card already says the turn waits, so no waiting row wedges between it and the composer.
        await expect(stripRows).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('approval-card.png') });
        // Typing a draft brings no key-hint row back either: the Send button's tooltip owns those keys.
        await message.fill('later');
        await expect(stripRows).toHaveCount(0);
        await message.fill('');
        await approval.getByRole('button', { name: 'Run', exact: true }).click();
        await expect(approval).toHaveCount(0);

        await message.fill('ask me');
        await message.press('Enter');
        const question = chat.getByRole('region', { name: 'Codex has a question' });
        // A lone question's header joins the title line instead of adding a second muted line.
        await expect(question.getByRole('heading', { level: 3 })).toHaveText(
            'Codex has a question · Color',
        );
        await expect(stripRows).toHaveCount(0);
        // The arrow centers on the whole option row, not on its title line.
        const blue = question.getByRole('radio', { name: /^Blue/u });
        await blue.hover();
        await expect
            .poll(() =>
                blue.evaluate((row) => {
                    const box = row.getBoundingClientRect();
                    const arrow = row.querySelector('svg:last-child')?.getBoundingClientRect();
                    if (!arrow) return NaN;
                    return Math.abs(arrow.top + arrow.height / 2 - (box.top + box.height / 2));
                }),
            )
            .toBeLessThan(1);
        await page.screenshot({ path: testInfo.outputPath('question-card.png') });
        await blue.click();
        await expect(chat.getByText('You chose Blue.')).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
