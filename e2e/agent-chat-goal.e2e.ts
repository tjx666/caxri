import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectComposerValue } from './support/agent-chat-composer.ts';
import {
    fakeClaudeChatAgentMode,
    fakeCodexChatAgentMode,
    openAgentChat,
} from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';
import { chooseContextMenuItem, contextMenuLabels } from './support/native-context-menu.ts';

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
        await expectComposerValue(message, '');
        await expect(message).toHaveAttribute(
            'aria-placeholder',
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
        await expectComposerValue(message, '');

        await message.fill('hold the line until the fixtures pass');
        await message.press('Enter');
        const row = chat.locator('[data-agent-chat-goal]');
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'active');
        await expect(row).toContainText('hold the line until the fixtures pass');
        await expect(goalChip).toHaveCount(0);
        // Codex starts the goal's turn on its own. The goal row shows that work live in place of the status row: its
        // time ticks and the goal's spend grows, and the active goal needs no status label.
        await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        await expect(row).toHaveAttribute('data-agent-chat-goal-live', '');
        await expect(row).not.toContainText('Pursuing goal');
        await expect(chat.locator('[data-agent-chat-status-row]')).toHaveCount(0);
        await expect(row.locator('[data-agent-chat-goal-time]')).toHaveAttribute(
            'data-value',
            /^[1-9]\d*s$/u,
            { timeout: 5000 },
        );
        await expect(row.locator('[data-agent-chat-turn-metric="steps"]')).toBeVisible({
            timeout: 5000,
        });
        await expect(row.locator('[data-agent-chat-goal-ripple]')).toHaveCount(1);
        // A message sent now adds to the goal's work, so the input names the goal rather than a turn.
        await expect(message).toHaveAttribute('aria-placeholder', 'Add to the goal');
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

/**
 * Claude Code holds a slash command until the running query ends, and a goal's query runs until its condition is met
 * (the fake streams until interrupted, `fake-claude-goal.ts`), so Clear stops the goal's turn instead of queueing.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat clears a goal while its turn runs without queueing the clear', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-claude-goal-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();

        await chat.getByRole('button', { name: 'Add files and more' }).click();
        await page.getByRole('menuitem', { name: /^Goal/u }).click();
        await message.fill('All tests pass');
        await message.press('Enter');
        const row = chat.locator('[data-agent-chat-goal]');
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'active');
        const stop = chat.getByRole('button', { name: 'Stop', exact: true });
        await expect(stop).toBeVisible();

        // A double click sends one clear; neither waits in the queue behind the goal's turn.
        await row.getByRole('button', { name: 'Clear goal' }).dblclick();
        await expect(row).toHaveCount(0);
        await expect(stop).toHaveCount(0);
        await expect(chat.getByRole('region', { name: 'Queued messages' })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('claude-goal-cleared.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a message sent without Goal mode becomes the goal from its right-click menu', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-goal-menu-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { app, page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        const objective = 'hold the release until the fixtures pass';
        await message.fill(objective);
        await message.press('Enter');
        const bubble = chat.locator('[data-agent-chat-user-bubble]').filter({ hasText: objective });
        // Right-click once the reply is in: the pending copy shown while the message is in flight has no menu.
        await expect(chat.getByText(`You said: ${objective}`)).toBeVisible();
        await expect(bubble).toBeVisible();

        await bubble.click({ button: 'right' });
        const labels = await contextMenuLabels(app);
        // Set as Goal follows Add to Message, which takes the same text.
        expect(labels.indexOf('Set as Goal')).toBe(labels.indexOf('Add to Message') + 1);
        expect(labels).toContain('Add to Message');
        await chooseContextMenuItem(app, 'Set as Goal');

        const row = chat.locator('[data-agent-chat-goal]');
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'active');
        await expect(row).toContainText(objective);
        await page.screenshot({ path: testInfo.outputPath('goal-from-message-menu.png') });

        await chat.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'paused');
        await row.getByRole('button', { name: 'Clear goal' }).click();
        await expect(row).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Goal mode dims attachments, says they stay for the next message, and keeps them after the goal is set', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-goal-files-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const notes = join(directory, 'notes.txt');
    await writeFile(notes, 'goal notes\n');
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        await chat.locator('input[type="file"]').setInputFiles([notes]);
        const attached = chat.getByRole('list', { name: 'Attachments' });
        await expect(attached.getByRole('listitem')).toHaveCount(1);
        const hint = chat.getByText(
            'The goal includes text only. Attachments stay for your next message.',
        );
        await expect(hint).toHaveCount(0);

        await chat.getByRole('button', { name: 'Add files and more' }).click();
        await page.getByRole('menuitem', { name: /^Goal/u }).click();
        await expect(hint).toBeVisible();
        await expect(attached).toHaveCSS('opacity', '0.5');
        await expect(page.getByRole('menu')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('goal-attachments-hint.png') });

        await message.fill('hold the line with notes attached');
        await message.press('Enter');
        const row = chat.locator('[data-agent-chat-goal]');
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'active');
        // The goal carried text only: the card is still in the composer, undimmed, for the next message.
        await expect(hint).toHaveCount(0);
        await expect(attached.getByRole('listitem')).toHaveCount(1);
        await expect(attached).toHaveCSS('opacity', '1');
        await page.screenshot({ path: testInfo.outputPath('goal-attachments-kept.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test("a Claude Code Chat's built-in /goal enters Goal mode on Tab instead of sending a bare /goal", async ({}, testInfo) => {
    // Claude Code keys its transcript directory by its real working directory, so the Project root must be resolved.
    const created = await mkdtemp(join(tmpdir(), 'caxri-claude-chat-goal-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toHaveAttribute('aria-placeholder', 'Message Claude');

        await message.fill('/go');
        const commands = chat.getByRole('listbox', { name: 'Commands and skills' });
        await expect(commands.getByRole('option').first()).toHaveText(/^\/goal/u);
        await message.press('Tab');
        const goalChip = chat.getByRole('button', {
            name: 'Goal mode',
            exact: true,
            pressed: true,
        });
        await expect(goalChip).toBeVisible();
        await expectComposerValue(message, '');
        await expect(message).toHaveAttribute(
            'aria-placeholder',
            'Describe your goal, define measurable outcomes for best results',
        );
        await page.screenshot({ path: testInfo.outputPath('claude-goal-mode.png') });

        // Enter sets the goal through Claude Code's own `/goal <condition>` and leaves Goal mode.
        await message.fill('the fixtures pass');
        await message.press('Enter');
        await expect(goalChip).toHaveCount(0);
        // The goal's query keeps streaming, so the sent `/goal` bubble can scroll out of the virtualized transcript;
        // the goal row proves Claude Code took the condition.
        const row = chat.locator('[data-agent-chat-goal]');
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'active');
        await expect(row).toContainText('the fixtures pass');
        await page.screenshot({ path: testInfo.outputPath('claude-goal-set.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * Claude Code writes how a goal ended only to its transcript, and the goal row keeps that outcome until cleared. The
 * fake's evaluator fails a condition naming `impossible` and meets one naming `achievable` (`fake-claude-goal.ts`).
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat goal row says whether the goal was achieved or could not be', async ({}, testInfo) => {
    // Claude Code keys its transcript directory by its real working directory, so the Project root must be resolved.
    const created = await mkdtemp(join(tmpdir(), 'caxri-claude-goal-outcome-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        const row = chat.locator('[data-agent-chat-goal]');
        const setGoal = async (condition: string) => {
            await chat.getByRole('button', { name: 'Add files and more' }).click();
            await page.getByRole('menuitem', { name: /^Goal/u }).click();
            await message.fill(condition);
            await message.press('Enter');
        };

        await setGoal('Ship an impossible fix');
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'failed');
        await expect(row).toContainText('Goal not achieved');
        await row.getByRole('button', { name: 'Show the whole goal' }).click();
        await expect(row.locator('[data-agent-chat-goal-reason]')).toHaveText(
            'The condition needs access this session does not have, so it cannot be met.',
        );
        await page.screenshot({ path: testInfo.outputPath('claude-goal-failed.png') });
        // An ended goal no longer runs a turn, so clearing it says Clear rather than Clear and stop.
        await expect(row.getByRole('button', { name: 'Clear goal', exact: true })).toBeVisible();

        await setGoal('Keep the achievable checks green');
        await expect(row).toHaveAttribute('data-agent-chat-goal', 'complete');
        await expect(row).toContainText('Goal achieved');
        await expect(row).toContainText('Keep the achievable checks green');
        await page.screenshot({ path: testInfo.outputPath('claude-goal-complete.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
