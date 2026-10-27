import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectDisclosuresSettled } from './support/agent-chat-disclosures.ts';
import { fakeClaudeChatAgentMode } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Code Chat streams a reply, answers an approval and a question, and resumes after a crash', async ({}, testInfo) => {
    /**
     * Claude Code keys its transcript directory by its real working directory, so the Project root must already be the
     * resolved path for Caxri to find the transcript it resumes from.
     */
    const created = await mkdtemp(join(tmpdir(), 'caxri-claude-chat-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        const terminalMenu = page.getByRole('menu', { name: 'New Terminal' });
        await terminalMenu.getByRole('menuitemcheckbox', { name: 'Open Agents in Chat' }).click();
        await chooseTerminalFromCreateMenu(page, 'Claude Chat');

        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toHaveAttribute('aria-placeholder', 'Message Claude');
        // Files can be picked as well as pasted or dropped (`agent-chat-input.e2e.ts` covers what a pick does).
        await expect(chat.getByRole('button', { name: 'Add files and more' })).toBeVisible();
        // Claude Code names its model only in a turn's init, so the picker reads as the default until then, but the
        // effort it will apply is known as soon as it starts.
        await expect(
            chat.getByRole('button', { name: 'Model: Default, Medium effort', exact: true }),
        ).toBeVisible();

        // The Terminal | Chat switch stays findable at rest: its pressed segment's icon is muted until the pointer
        // enters the tab bar. Only that color changes, so the track and thumb keep full contrast.
        const pressedSegment = chat.locator('.agent-surface-toggle [data-pressed]');
        const surfaceToggle = chat.locator('.agent-surface-toggle');
        await message.hover();
        await expect(surfaceToggle).toHaveCSS('opacity', '1');
        const restColor = await pressedSegment.evaluate(
            (element) => getComputedStyle(element).color,
        );
        await chat.locator('.work-tabs').first().hover();
        await expect(pressedSegment).not.toHaveCSS('color', restColor);
        await page.screenshot({ path: testInfo.outputPath('claude-chat-tab-hover.png') });
        await message.hover();
        await expect(pressedSegment).toHaveCSS('color', restColor);

        await message.fill('hi there');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Claude. You said: hi there')).toBeVisible();
        // The init names the model, and the turn's hook input names the effort Claude Code actually applied.
        await expect(
            chat.getByRole('button', { name: 'Model: Fake, Medium effort', exact: true }),
        ).toBeVisible();
        // Even the latest reply mounts its Copy action and time only while hovered.
        const latestReply = chat
            .locator('[data-agent-chat-reply]')
            .filter({ hasText: 'Hello from fake Claude. You said: hi there' });
        await message.hover();
        await expect(latestReply.getByRole('button', { name: 'Copy message' })).toHaveCount(0);
        await expect(latestReply.locator('time')).toHaveCount(0);
        await latestReply.hover();
        await expect(latestReply.getByRole('button', { name: 'Copy message' })).toBeVisible();
        await expect(latestReply.locator('time')).toBeVisible();
        await message.hover();
        await expect(chat.getByRole('meter', { name: /^\d+% of context used, /u })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-reply.png') });
        // The meter measures against the compaction window and its card lists what fills the context. The card opens on
        // click only, so passing the pointer over the composer's bottom row never covers the draft.
        const contextMeter = chat.getByRole('meter', { name: /^\d+% of context used, /u });
        await contextMeter.hover();
        await expect(page.getByText('Auto-compacts at 160k of the 200k window')).toHaveCount(0);
        await contextMeter.click();
        await expect(page.getByText('Context', { exact: true })).toBeVisible();
        await expect(page.getByText('Messages', { exact: true })).toBeVisible();
        await expect(page.getByText('Auto-compacts at 160k of the 200k window')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-context-breakdown.png') });
        // Escape closes the card and hands focus back to the meter.
        await page.keyboard.press('Escape');
        await expect(page.getByText('Auto-compacts at 160k of the 200k window')).toHaveCount(0);
        await expect(contextMeter).toBeFocused();

        await message.fill('please approve this');
        await message.press('Enter');
        const approval = chat.getByRole('region', { name: 'Run this command?' });
        await expect(approval).toContainText('echo approved');
        await expect(approval).toContainText('Fake Bash approval');
        await page.screenshot({ path: testInfo.outputPath('claude-chat-approval.png') });
        await approval.getByRole('button', { name: 'Run', exact: true }).click();
        await expect(approval).toHaveCount(0);
        await expect(chat.getByText('The command ran.')).toBeVisible();
        // The row reads the Agent's description of the command, and expanded shows the command and how it ended.
        await chat
            .getByRole('button', { name: /^Worked(?: for |$)/u })
            .last()
            .click();
        // A settled run of one command is that command's own row, not a `Ran 1 command` summary over it.
        await expect(chat.getByRole('button', { name: 'Ran 1 command', exact: true })).toHaveCount(
            0,
        );
        const commandRow = chat.getByRole('button', { name: /^Ran Print a confirmation/u });
        // The toggle is stretched over its row, which holds the visible title and facts. The fake command finishes well
        // under a second, and a sub-second duration is left out as noise.
        await expect(commandRow.locator('xpath=..')).not.toContainText(/\d+(?:ms|s)$/u);
        await commandRow.click();
        await expect(chat.getByText('Exit code 0')).toBeVisible();
        await expect(chat.locator('pre').filter({ hasText: 'echo approved' })).toBeVisible();
        await expectDisclosuresSettled(chat, 'agent-chat-item');
        await page.screenshot({ path: testInfo.outputPath('claude-chat-command.png') });

        await message.fill('ask me');
        await message.press('Enter');
        const question = chat.getByRole('region', { name: 'Claude has a question' });
        await question.getByRole('radio', { name: /^Blue/u }).click();
        await expect(chat.getByText('You chose Blue.')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-question.png') });

        // A context past 85% of the compaction window suggests compacting, under the composer.
        await message.fill('large context please');
        await message.press('Enter');
        await expect(
            chat.getByText('Hello from fake Claude. You said: large context please'),
        ).toBeVisible();
        await expect(
            chat.getByText(/^Context [\d.]+k \/ 160k · consider compacting$/u),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-context-pressure.png') });

        // A crash fails the Chat; Retry resumes the same Claude Code session and reloads its history from the transcript.
        await message.fill('crash now');
        await message.press('Enter');
        const failure = chat.getByRole('alert').filter({ hasText: 'Claude stopped unexpectedly' });
        await expect(failure).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-crashed.png') });
        await failure.getByRole('button', { name: 'Retry' }).click();
        await expect(failure).toHaveCount(0);
        await expect(chat.getByText('You chose Blue.')).toBeVisible();
        await message.fill('back again');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Claude. You said: back again')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-resumed.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
