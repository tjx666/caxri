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
test('a Chat asks several questions behind tabs and lists the answers once sent', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-questions-'));
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
        // Several questions sit behind tabs, one at a time; answering moves to the next unanswered question.
        await message.fill('ask several questions');
        await message.press('Enter');
        const questions = session.getByRole('region', { name: 'Codex has 3 questions' });
        const questionTabs = questions.getByRole('tab');
        await expect(questionTabs).toHaveCount(3);
        // The recommended option starts selected, so the first question already counts as answered.
        await expect(questionTabs.nth(0)).toHaveAttribute('aria-description', 'Answered');
        await expect(questionTabs.nth(1)).toHaveAttribute('aria-description', 'Not answered yet');
        await expect(questions.getByText('Which users count as free?')).toBeHidden();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-questions.png') });
        await questions.getByRole('radio', { name: /^Per request/u }).focus();
        await page.keyboard.press('Enter');
        await expect(questionTabs.nth(1)).toHaveAttribute('aria-selected', 'true');
        await expect(questions.getByRole('radio', { name: /^Free and Hobby/u })).toBeFocused();
        await page.keyboard.press('2');
        await expect(questionTabs.nth(2)).toHaveAttribute('aria-selected', 'true');
        // Going back keeps the earlier answer, and changing it there moves on to the question still unanswered
        // without resetting the one answered in between.
        await questionTabs.nth(0).click();
        await expect(questions.getByRole('radio', { name: /^Per request/u })).toBeChecked();
        await questions.getByRole('radio', { name: /^Per user/u }).click();
        await expect(questionTabs.nth(2)).toHaveAttribute('aria-selected', 'true');
        await questionTabs.nth(1).click();
        await expect(questions.getByRole('radio', { name: /^Free only/u })).toBeChecked();
        await questions.getByRole('button', { name: 'Submit' }).click();
        await expect(
            session.getByText('You answered Per user (Recommended) / Free only / -.'),
        ).toBeVisible();
        const answeredSeveral = session.locator('[data-agent-chat-answered]').last();
        await expect(
            answeredSeveral.getByRole('button', { name: 'Asked 3 questions' }),
        ).toBeVisible();
        await expect(answeredSeveral).toContainText('Anything else to keep in mind?Skipped');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-questions-answered.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
