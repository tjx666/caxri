import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composerValue, expectComposerValue } from './support/agent-chat-composer.ts';
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
        await expectComposerValue(
            message,
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

        // The header counts the comments waiting in the message; editing and removing stay in step with the composer.
        await expect(review.getByText('1 comment', { exact: true })).toBeVisible();
        const note = greeting.getByRole('note', { name: 'Comment on New L2–3' });
        await note.getByRole('button', { name: 'Edit comment' }).click();
        await greeting.getByRole('textbox', { name: 'Comment' }).fill('Inline the constant');
        await greeting.getByRole('button', { name: 'Save' }).click();
        await expect(note).toContainText('Inline the constant');
        await expectComposerValue(message, /Inline the constant$/u);
        await expect.poll(() => composerValue(message)).not.toMatch(/Name the constant message/u);

        await note.getByRole('button', { name: 'Remove comment' }).click();
        await expect(note).toHaveCount(0);
        await expectComposerValue(message, '');
        await expect(review.getByText('1 comment', { exact: true })).toHaveCount(0);
        await page
            .locator('[data-sonner-toast]')
            .getByRole('button', { name: 'Undo', exact: true })
            .click();
        await expect(note).toContainText('Inline the constant');
        await expectComposerValue(message, /Inline the constant$/u);
        await expect(review.getByText('1 comment', { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('turn-review-edited.png') });

        // Back to Chat and Send returns to the Chat and sends the message with the comments in it.
        await review.getByRole('button', { name: 'Back to Chat and Send' }).click();
        await expect(
            session
                .locator('[data-agent-chat-user-message]')
                .filter({ hasText: 'Inline the constant' }),
        ).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
