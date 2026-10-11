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
test('a Codex turn opens as one review whose line comments land in the Chat message', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-review-'));
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
        const session = page.locator(VISIBLE_SESSION);
        const message = session.getByRole('textbox', { name: 'Message' });
        await message.fill('artifacts please');
        await message.press('Enter');

        const changes = session.locator('[data-agent-chat-turn-changes]');
        await expect(changes.getByText('Edited 2 files')).toBeVisible();
        await changes.getByRole('button', { name: 'Review' }).click();

        const review = session.locator('[data-agent-chat-turn-review]');
        await expect(review.getByRole('heading', { name: 'Turn changes' })).toBeVisible();
        await expect(review.getByRole('region')).toHaveCount(2);
        const greeting = review.getByRole('region', { name: 'src/greeting.ts' });
        await expect(review.getByRole('region', { name: 'docs/greeting.md' })).toBeVisible();

        await greeting.getByRole('button', { name: 'Comment on line 2', exact: true }).click();
        await greeting
            .getByRole('button', { name: 'Comment on line 3', exact: true })
            .click({ modifiers: ['Shift'] });
        const comment = greeting.getByRole('textbox', { name: 'Comment' });
        await comment.fill('Name the constant message');
        await page.screenshot({ path: testInfo.outputPath('turn-review-comment.png') });
        await comment.press('Meta+Enter');

        await expect(greeting.getByRole('note', { name: 'Comment on New L2–3' })).toContainText(
            'Name the constant message',
        );
        await expect(message).toHaveValue(
            [
                '@src/greeting.ts#L2-L3 (Agent turn diff, modified side)',
                '```diff',
                '+    const greeting = `Hello, ${name}!`;',
                '+    return greeting;',
                '```',
                'Name the constant message',
            ].join('\n'),
        );
        await page.screenshot({ path: testInfo.outputPath('turn-review-added.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
