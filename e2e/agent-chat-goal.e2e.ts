import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

/**
 * Goal mode and the goal row against the fake Codex app-server, whose goal turns stream until stopped when the
 * objective contains `hold` (`fake-codex-goals.ts`).
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat sets, pauses, resumes, and clears a goal', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-goal-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        const form = message.locator('xpath=ancestor::form[1]');

        await message.fill('/go');
        const commands = chat.getByRole('listbox', { name: 'Commands and skills' });
        await expect(commands.getByRole('option').first()).toHaveText(/^\/goal/u);
        await page.screenshot({ path: testInfo.outputPath('goal-command.png') });

        // Choosing /goal enters Goal mode instead of leaving the command in the draft.
        await message.press('Enter');
        const goalChip = chat.getByRole('button', {
            name: 'Goal mode',
            exact: true,
            pressed: true,
        });
        await expect(goalChip).toBeVisible();
        await expect(message).toHaveValue('');
        await expect(message).toHaveAttribute(
            'placeholder',
            'Describe your goal, define measurable outcomes for best results',
        );
        await form.screenshot({ path: testInfo.outputPath('goal-mode.png') });
        // Backspace in an empty draft leaves Goal mode, as the chip does.
        await message.press('Backspace');
        await expect(goalChip).toHaveCount(0);
        await message.fill('/goal ');
        await message.press('Escape');
        // The + menu's Goal enters Goal mode too, taking a typed `/goal` out of the draft.
        await chat.getByRole('button', { name: 'Add files and more' }).click();
        await page.getByRole('menuitem', { name: /^Goal/u }).click();
        await expect(goalChip).toBeVisible();
        await expect(message).toHaveValue('');

        await message.fill('hold the line until the fixtures pass');
        await message.press('Enter');
        const row = chat.locator('[data-agent-chat-goal]');
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'active');
        await expect(row).toContainText('Pursuing goal');
        await expect(row).toContainText('hold the line until the fixtures pass');
        await expect(goalChip).toHaveCount(0);
        // Codex starts the goal's turn on its own; the row's time ticks while it runs.
        await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        await expect(row).toContainText(/[1-9]\d*s$/u, { timeout: 5000 });
        await page.screenshot({ path: testInfo.outputPath('goal-active.png') });

        // Pause runs while the turn is still going, rather than waiting in the follow-up queue.
        await row.getByRole('button', { name: 'Pause goal' }).click();
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'paused');
        await expect(row).toContainText('Goal paused');
        await row.getByRole('button', { name: 'Show the whole goal' }).click();
        await expect(row.getByRole('button', { name: 'Collapse goal' })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('goal-paused-expanded.png') });

        await row.getByRole('button', { name: 'Resume goal' }).click();
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'active');
        // Stop pauses the goal so Codex does not start its next turn right away.
        await chat.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'paused');
        await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

        await row.getByRole('button', { name: 'Clear goal' }).click();
        await expect(row).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
