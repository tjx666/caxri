import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator } from '@playwright/test';

import { fakeClaudeChatAgentMode, fakeCodexChatAgentMode } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    VISIBLE_SESSION,
    waitForCreatedSession,
} from './support/helpers.ts';

/**
 * Waits until every expanded disclosure of one kind has finished its height transition, so a screenshot shows the
 * opened content rather than the first frame of the animation.
 */
async function expectDisclosuresSettled(scope: Locator, kind: string): Promise<void> {
    await expect
        .poll(() =>
            scope
                .locator(`[data-disclosure="${kind}"][data-expanded="true"]`)
                .evaluateAll((nodes) =>
                    nodes.every(
                        (node) =>
                            Math.abs(node.getBoundingClientRect().height - node.scrollHeight) < 1,
                    ),
                ),
        )
        .toBe(true);
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat streams a reply, answers an approval and a question', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
        join(root, 'src', 'app.ts'),
        'export const app = 1;\nexport const cited = 2;\n',
    );
    // The file the fake `patch` change updates, so its path can open in the Editor.
    await writeFile(
        join(root, 'src', 'greeting.ts'),
        "export function greet(name: string) {\n    return 'Hello ' + name;\n}\n",
    );
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        // One row per Agent. The footer toggle keeps the menu open and turns the Chat-capable rows into Chats.
        const terminalMenu = page.getByRole('menu', { name: 'New Terminal' });
        const openInChat = terminalMenu.getByRole('menuitemcheckbox', { name: 'Open in Chat' });
        await expect(openInChat).not.toBeChecked();
        await expect(terminalMenu.getByRole('menuitem')).toHaveText([
            'Claude',
            'Codex',
            'Grok Build',
            'Shell',
        ]);
        await openInChat.click();
        await expect(openInChat).toBeChecked();
        await expect(terminalMenu.getByRole('menuitem')).toHaveText([
            'ClaudeChat',
            'CodexChat',
            'Grok Build',
            'Shell',
        ]);
        await page.screenshot({ path: testInfo.outputPath('agent-chat-new-terminal-menu.png') });
        await chooseTerminalFromCreateMenu(page, 'Codex Chat');

        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        await message.fill('hi there');
        // Sent straight away, while the provider may still be starting: the first Enter must not be dropped.
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Codex. You said: hi there')).toBeVisible();
        await expect(message).toHaveAttribute('placeholder', 'Message Codex');
        // The composer keeps the model and the context used in view, as the Codex app does.
        await expect(chat.getByRole('button', { name: /^Model: Fake Codex, / })).toBeVisible();
        await expect(chat.getByRole('img', { name: /^\d+% of context used$/u })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-reply.png') });

        await message.fill('please approve this');
        await message.press('Enter');
        const approval = chat.getByRole('region', { name: 'Run this command?' });
        await expect(approval).toContainText('echo approved');
        await expect(approval.getByRole('button', { name: 'Accept for this Chat' })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-approval.png') });
        await approval.getByRole('button', { name: 'Accept', exact: true }).click();
        await expect(approval).toHaveCount(0);
        await expect(message).toHaveAttribute('placeholder', 'Message Codex');

        await message.fill('ask me');
        await message.press('Enter');
        const question = chat.getByRole('region', { name: 'The Agent has a question' });
        await question.getByRole('button', { name: /^Blue/u }).click();
        await question.getByRole('button', { name: 'Submit' }).click();
        await expect(chat.getByText('You chose Blue.')).toBeVisible();
        await expect(chat.getByText('Answered: Color: Blue')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-question.png') });

        // Consecutive tool calls fold into one summary; a finished turn folds its work behind its duration.
        await message.fill('explore the project');
        await message.press('Enter');
        await expect(chat.getByText('Explored the project.')).toBeVisible();
        await chat
            .getByRole('button', { name: /^Worked for /u })
            .last()
            .click();
        const workGroup = chat.getByRole('button', { name: 'Ran 2 commands, called 1 MCP tool' });
        await expect(workGroup).toHaveAttribute('aria-expanded', 'false');
        await workGroup.click();
        await expect(chat.getByRole('button', { name: 'docs search' })).toBeVisible();
        await chat.getByRole('button', { name: 'Ran cat src/app.ts' }).click();
        // A printed file's output is painted in that file's language.
        await expect(chat.locator('pre code span[class*="mtk"]').first()).toBeVisible();
        await expectDisclosuresSettled(chat, 'agent-chat-item');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-work-group.png') });
        const exploreFold = chat.getByRole('button', { name: /^Worked for /u }).last();
        await exploreFold.click();
        await expect(exploreFold).toHaveAttribute('aria-expanded', 'false');

        // Headings, task lists, tables, and fenced code keep their structure in the transcript.
        await message.fill('show a table');
        await message.press('Enter');
        const table = chat.getByRole('table');
        await expect(table.getByRole('columnheader', { name: 'Cost' })).toBeVisible();
        await expect(table.getByRole('cell', { name: 'Safe' })).toBeVisible();
        await expect(chat.getByRole('heading', { name: 'Summary', level: 2 })).toBeVisible();
        await expect(
            chat.getByRole('listitem').filter({ hasText: 'Done: Write tests' }),
        ).toBeVisible();
        await expect(chat.getByRole('button', { name: 'Copy code' })).toBeVisible();
        await expect(chat.getByRole('button', { name: 'Enable word wrap' })).toBeVisible();
        // A finished block is painted with the editor's token colors.
        await expect(chat.locator('pre code span[class*="mtk"]').first()).toBeVisible();
        await chat.getByText('Ship it').hover();
        await expect(chat.getByRole('button', { name: 'Copy message' }).last()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-table.png') });
        // A cited file opens in the editor at the cited line.
        await chat.getByRole('button', { name: 'app.ts', exact: true }).click();
        await expect(page.getByRole('tab', { name: 'app.ts' })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-file-link.png') });
        await page.getByRole('tab', { name: 'Codex', exact: true }).click();
        await expect(message).toBeVisible();

        // A crash fails the Chat; Retry restarts the provider on the same conversation and the pane follows it.
        await message.fill('crash now');
        await message.press('Enter');
        const failure = chat.getByRole('alert').filter({ hasText: 'Codex stopped unexpectedly' });
        await expect(failure).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-crashed.png') });
        await failure.getByRole('button', { name: 'Retry' }).click();
        await expect(failure).toHaveCount(0);
        await message.fill('back again');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Codex. You said: back again')).toBeVisible();
        await expect(chat.getByText('You chose Blue.')).toBeVisible();

        // The tab strip's `+` clones the live primary Agent on its own surface: a Chat, not a PTY.
        await chat.getByRole('button', { name: 'New Terminal (Codex Chat)' }).click();
        await expect(chat.getByText('You chose Blue.')).toHaveCount(0);
        await expect(message).toHaveAttribute('placeholder', 'Message Codex');
        // The `+` opens its Agent menu on hover; leave it so only the New Session menu below offers "Codex Chat".
        await page.mouse.move(0, 0);
        await expect(page.getByRole('menu', { name: 'New Terminal (Codex Chat)' })).toHaveCount(0);

        // The sidebar's New Session menu shares the preference, so a whole Session can start as a Chat.
        const previous = await pageRequest<{ selectedSessionId?: string }>(page, 'app.bootstrap');
        const newSession = page.getByRole('button', { name: /^New Session in / });
        // Opened from the keyboard: on the CI runner a synthesized pointer over the sidebar heading lands on `<html>`
        // even though `elementFromPoint` hits the heading, so a hover-then-click never reaches the trigger.
        await newSession.focus();
        await newSession.press('Enter');
        const sessionMenu = page.getByRole('menu', { name: /^New Session in / });
        await expect(
            sessionMenu.getByRole('menuitemcheckbox', { name: 'Open in Chat' }),
        ).toBeChecked();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-new-session-menu.png') });
        await chooseTerminalFromCreateMenu(page, 'Codex Chat');
        const sessionId = await waitForCreatedSession(page, previous.selectedSessionId);
        const state = await pageRequest<{
            terminals: Array<{ sessionId: string; surface?: string }>;
        }>(page, 'app.bootstrap');
        expect(state.terminals.filter((terminal) => terminal.sessionId === sessionId)).toEqual([
            expect.objectContaining({ surface: 'chat' }),
        ]);
        await expect(message).toHaveAttribute('placeholder', 'Message Codex');
        await message.fill('from a new Session');
        await message.press('Enter');
        await expect(
            chat.getByText('Hello from fake Codex. You said: from a new Session'),
        ).toBeVisible();

        // A file-change approval previews each file's colored diff before Accept.
        await message.fill('make a patch');
        await message.press('Enter');
        const fileApproval = chat.getByRole('region', { name: 'Apply these file changes?' });
        await expect(fileApproval).toContainText('src/greeting.ts');
        await expect(fileApproval).toContainText('docs/greeting.md');
        await expect(fileApproval).toContainText('legacy.txt');
        // Several files start as headers; the user opens the one to read.
        await expect(fileApproval.locator('[data-diff-line]')).toHaveCount(0);
        await fileApproval.getByRole('button', { name: 'Show diff: src/greeting.ts' }).click();
        await expect(fileApproval.locator('[data-diff-line="added"]')).toHaveCount(2);
        await expect(fileApproval.locator('[data-diff-line="removed"]')).toHaveCount(1);
        await expect(fileApproval.getByText('return greeting;')).toBeVisible();
        await expectDisclosuresSettled(fileApproval, 'agent-chat-file-change');
        await expect(fileApproval.getByText('Diff truncated')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('agent-chat-diff-approval.png') });
        await fileApproval.getByRole('button', { name: 'Accept', exact: true }).click();
        await expect(fileApproval).toHaveCount(0);
        await expect(chat.getByText('The files were changed.')).toBeVisible();

        // The finished turn folds its work behind its duration, keeping the prompt and the reply in view.
        const turnFold = chat.getByRole('button', { name: /^Worked for /u }).last();
        await expect(turnFold).toHaveAttribute('aria-expanded', 'false');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-turn-folded.png') });
        await turnFold.click();
        // The change names its first file and line totals, then lists each file's diff.
        const changeRow = chat.getByRole('button', {
            name: /^Edited greeting\.ts \+2 more ?, 5 lines added, 2 removed$/u,
        });
        await expect(changeRow).toHaveAttribute('aria-expanded', 'false');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-diff-collapsed.png') });
        await changeRow.click();
        await expect(chat.getByText('const greeting = `Hello, ${name}!`;')).toBeVisible();
        await expect(chat.getByText('Call `greet(name)`.')).toBeVisible();
        await expectDisclosuresSettled(chat, 'agent-chat-turn');
        await expectDisclosuresSettled(chat, 'agent-chat-item');
        await expectDisclosuresSettled(chat, 'agent-chat-file-change');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-diff-expanded.png') });

        // A diff Server Core cut says so where it stops.
        await message.fill('write a bigdiff');
        await message.press('Enter');
        await expect(chat.getByText('Generated a large file.')).toBeVisible();
        await chat
            .getByRole('button', { name: /^Worked for /u })
            .last()
            .click();
        await chat.getByRole('button', { name: /^Edited generated\.txt ?, / }).click();
        // The header says so up front; the note at the cut is a scroll away in a long diff.
        await expect(chat.getByText('Truncated', { exact: true })).toBeVisible();
        await expectDisclosuresSettled(chat, 'agent-chat-item');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-diff-truncated.png') });
        const truncatedNote = chat.getByText('Diff truncated');
        await truncatedNote.scrollIntoViewIfNeeded();
        await expect(truncatedNote).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-diff-truncated-end.png') });

        // An applied file's path opens it in the Editor.
        await chat.getByRole('button', { name: 'Open src/greeting.ts in Editor' }).click();
        await expect(page.getByRole('tab', { name: 'greeting.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * A running Chat has no PTY, yet its provider process outlives the window: closing must ask first and Terminate must
 * stop it (caxri#1536). The native dialog is stubbed; only the requested count and the outcome are asserted.
 */
test('closing the window with only a Chat running asks first and Terminate stops it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-close-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        const terminalMenu = page.getByRole('menu', { name: 'New Terminal' });
        await terminalMenu.getByRole('menuitemcheckbox', { name: 'Open in Chat' }).click();
        await chooseTerminalFromCreateMenu(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('hi there');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Codex. You said: hi there')).toBeVisible();

        // Close the Session's shell PTY so the Chat is the only running Terminal.
        const bootstrap = await pageRequest<{
            terminals: Array<{ id: string; surface?: string }>;
        }>(page, 'app.bootstrap', {});
        for (const terminal of bootstrap.terminals) {
            if (terminal.surface === 'chat') continue;
            // eslint-disable-next-line no-await-in-loop -- Serialized closes keep Session focus deterministic.
            await pageRequest(page, 'terminal.close', { terminalId: terminal.id });
        }
        await expect(message).toBeVisible();
        await expect.poll(() => pageRequest<number>(page, 'terminal.runningCount', {})).toBe(1);

        await running.app.evaluate(({ dialog }) => {
            // Records the prompt, then picks "Terminate and Close".
            dialog.showMessageBox = (...parameters: unknown[]) => {
                const options = parameters.at(-1) as { message?: string };
                Reflect.set(globalThis, '__caxriCloseConfirmMessage', options.message);
                return Promise.resolve({ response: 1, checkboxChecked: false });
            };
        });
        const closed = page.waitForEvent('close');
        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.close(),
        );
        await closed;
        expect(
            await running.app.evaluate(() => {
                const value: unknown = Reflect.get(globalThis, '__caxriCloseConfirmMessage');
                return typeof value === 'string' ? value : undefined;
            }),
        ).toBe('1 Terminal is still running.');
        const log = join(userData, 'logs', 'server-core.jsonl');
        await expect
            .poll(async () =>
                (await readFile(log, 'utf8'))
                    .trim()
                    .split('\n')
                    .map(
                        (line) =>
                            JSON.parse(line) as {
                                event?: string;
                                fields?: { requested?: boolean };
                            },
                    )
                    .some(
                        (record) =>
                            record.event === 'agent_chat.process_exited' &&
                            record.fields?.requested === true,
                    ),
            )
            .toBe(true);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

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
        await terminalMenu.getByRole('menuitemcheckbox', { name: 'Open in Chat' }).click();
        await chooseTerminalFromCreateMenu(page, 'Claude Chat');

        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toHaveAttribute('placeholder', 'Message Claude');
        // Claude Code names its model only in a turn's init, so the picker reads as the default until then.
        await expect(chat.getByRole('button', { name: 'Model: Default' })).toBeVisible();
        await message.fill('hi there');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Claude. You said: hi there')).toBeVisible();
        await expect(chat.getByRole('button', { name: 'Model: Fake' })).toBeVisible();
        await expect(chat.getByRole('img', { name: /^\d+% of context used$/u })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-reply.png') });

        await message.fill('please approve this');
        await message.press('Enter');
        const approval = chat.getByRole('region', { name: 'Run this command?' });
        await expect(approval).toContainText('echo approved');
        await expect(approval).toContainText('Fake Bash approval');
        await page.screenshot({ path: testInfo.outputPath('claude-chat-approval.png') });
        await approval.getByRole('button', { name: 'Accept', exact: true }).click();
        await expect(approval).toHaveCount(0);
        await expect(chat.getByText('The command ran.')).toBeVisible();
        // The row reads the Agent's description of the command, and expanded shows the command and how it ended.
        await chat
            .getByRole('button', { name: /^Worked for /u })
            .last()
            .click();
        const commandRow = chat.getByRole('button', { name: /^Ran Print a confirmation/u });
        await expect(commandRow).toContainText(/\d+s$/u);
        await commandRow.click();
        await expect(chat.getByText('Exit code 0')).toBeVisible();
        await expect(chat.locator('pre').filter({ hasText: 'echo approved' })).toBeVisible();
        await expectDisclosuresSettled(chat, 'agent-chat-item');
        await page.screenshot({ path: testInfo.outputPath('claude-chat-command.png') });

        await message.fill('ask me');
        await message.press('Enter');
        const question = chat.getByRole('region', { name: 'The Agent has a question' });
        await question.getByRole('button', { name: /^Blue/u }).click();
        await question.getByRole('button', { name: 'Submit' }).click();
        await expect(chat.getByText('You chose Blue.')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-question.png') });

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
