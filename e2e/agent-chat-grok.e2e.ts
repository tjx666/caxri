import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeGrokChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Grok Build Chat streams a reply, answers an approval and a question, switches its model, and resumes after a crash', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-grok-chat-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeGrokChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Grok Build Chat');

        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toHaveAttribute('placeholder', 'Message Grok Build');
        await message.fill('hi there');
        await message.press('Enter');
        await expect(chat.getByText('You said: hi there')).toBeVisible();
        const picker = chat.getByRole('button', { name: /^Model: / });
        await expect(picker).toHaveAccessibleName('Model: Grok Fake');
        await expect(chat.getByRole('meter', { name: /^\d+% of context used, /u })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('grok-chat-reply.png') });

        await message.fill('please approve this');
        await message.press('Enter');
        const approval = chat.getByRole('region', { name: 'Run this command?' });
        await expect(approval).toContainText('npm test');
        await page.screenshot({ path: testInfo.outputPath('grok-chat-approval.png') });
        await approval.getByRole('button', { name: 'Run', exact: true }).click();
        await expect(approval).toHaveCount(0);
        await expect(chat.getByText('The command ran.')).toBeVisible();

        await message.fill('ask me a question');
        await message.press('Enter');
        const question = chat.getByRole('region', { name: 'Grok Build has 2 questions' });
        await expect(question).toContainText('Which color?');
        await page.screenshot({ path: testInfo.outputPath('grok-chat-question.png') });
        await question.getByRole('button', { name: /^Blue/u }).click();
        await question.getByRole('button', { name: 'Large', exact: true }).click();
        await question.getByRole('button', { name: 'Submit' }).click();
        await expect(question).toHaveCount(0);
        await expect(chat.getByText('Answered: Which color?: Blue')).toBeVisible();
        // A multi-select question goes back to Grok Build as a list.
        await expect(
            chat.getByText('Answers: {"Which color?":"Blue","Which sizes?":["Large"]}'),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('grok-chat-question-answered.png') });

        await picker.click();
        const menu = page.getByRole('menu');
        await expect(menu.getByRole('menuitemradio')).toHaveText([
            'Grok Fake',
            /Grok Fake Fast\s*Faster replies/,
        ]);
        await menu.getByRole('menuitemradio', { name: /Grok Fake Fast/ }).click();
        await expect(picker).toHaveAccessibleName('Model: Grok Fake Fast');
        await page.keyboard.press('Escape');
        await message.fill('which model');
        await message.press('Enter');
        await expect(chat.getByText('You said: which model (grok-fake-fast)')).toBeVisible();

        // A crash fails the Chat; Retry reloads the same Grok Build session, whose history session/load replays.
        await message.fill('crash now');
        await message.press('Enter');
        const failure = chat
            .getByRole('alert')
            .filter({ hasText: 'Grok Build stopped unexpectedly' });
        await expect(failure).toBeVisible();
        await failure.getByRole('button', { name: 'Retry' }).click();
        await expect(failure).toHaveCount(0);
        await expect(chat.getByText('You said: hi there')).toBeVisible();
        await message.fill('back again');
        await message.press('Enter');
        await expect(chat.getByText('You said: back again')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('grok-chat-resumed.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
