import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectDisclosuresSettled } from './support/agent-chat-disclosures.ts';
import { fakeCodexChatAgentMode } from './support/agent-chat-fixture.ts';
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
import { runningWork } from './support/running-work.ts';

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
        const openInChat = terminalMenu.getByRole('menuitemcheckbox', {
            name: 'Open Agents in Chat',
        });
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
            'Grok BuildChat',
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
        await expect(chat.getByRole('meter', { name: /^\d+% of context used, /u })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-reply.png') });
        const planRow = chat.getByRole('button', {
            name: 'Plan: 1 of 2 steps done. Current step: Reply',
        });
        await expect(planRow).toHaveAttribute('aria-expanded', 'false');
        await expect(chat.getByRole('region', { name: 'Plan' }).getByRole('listitem')).toHaveCount(
            0,
        );
        await planRow.click();
        await expect(chat.getByRole('region', { name: 'Plan' }).getByRole('listitem')).toHaveText([
            'Read the message',
            'Reply',
        ]);
        await page.screenshot({ path: testInfo.outputPath('agent-chat-plan-expanded.png') });
        await planRow.click();

        await message.fill('please approve this');
        await message.press('Enter');
        const approval = chat.getByRole('region', { name: 'Run this command?' });
        await expect(approval).toContainText('echo approved');
        await expect(
            approval.getByRole('button', { name: 'Always Allow in This Chat' }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-approval.png') });
        await approval.getByRole('button', { name: 'Run', exact: true }).click();
        await expect(approval).toHaveCount(0);
        await expect(message).toHaveAttribute('placeholder', 'Message Codex');

        await message.fill('ask me');
        await message.press('Enter');
        const question = chat.getByRole('region', { name: 'Codex has a question' });
        // The transcript marks the question being asked while the card waits, as the Codex app does.
        await expect(chat.locator('[data-agent-chat-asking]')).toHaveText('Asking a question');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-question.png') });
        // One click answers a lone question.
        await question.getByRole('radio', { name: /^Blue/u }).click();
        await expect(chat.getByText('You chose Blue.')).toBeVisible();
        await expect(chat.locator('[data-agent-chat-asking]')).toHaveCount(0);
        const answered = chat.locator('[data-agent-chat-answered]').last();
        await expect(answered.getByRole('button', { name: 'Asked a question' })).toHaveAttribute(
            'aria-expanded',
            'true',
        );
        await expect(answered).toContainText('Which color?Blue');

        // Consecutive tool calls fold into one summary; a finished turn folds its work behind its duration.
        await message.fill('explore the project');
        await message.press('Enter');
        await expect(chat.getByText('Explored the project.')).toBeVisible();
        await chat
            .getByRole('button', { name: /^Worked(?: for |$)/u })
            .last()
            .click();
        /**
         * Only the reply that ends each turn carries Copy, so commentary between tool calls reserves no action row.
         * Copy mounts only while the reply is hovered.
         */
        const reply = (text: string) =>
            chat.locator('[data-agent-chat-reply]').filter({ hasText: text });
        await expect(reply('Looking around the project.')).toBeVisible();
        await reply('Looking around the project.').hover();
        const copyOf = (text: string) => reply(text).getByRole('button', { name: 'Copy message' });
        await expect(copyOf('Looking around the project.')).toHaveCount(0);
        await expect(copyOf('Explored the project.')).toHaveCount(0);
        await reply('Explored the project.').hover();
        await expect(copyOf('Explored the project.')).toHaveCount(1);
        /**
         * The keyboard reaches any message's Copy without a Tab stop per message: Option+ArrowUp in the transcript
         * focuses the latest reply, which mounts its action row, and each further press steps to the message before it,
         * the user's own messages included (commentary without Copy is skipped), and Tab continues to its Copy.
         */
        await message.hover();
        await chat.getByRole('log', { name: 'Conversation' }).focus();
        await page.keyboard.press('Alt+ArrowUp');
        await expect(reply('Explored the project.')).toBeFocused();
        await expect(copyOf('Explored the project.')).toBeVisible();
        await page.keyboard.press('Alt+ArrowUp');
        const prompt = chat
            .locator('[data-agent-chat-user-message]')
            .filter({ hasText: 'explore the project' });
        await expect(prompt).toBeFocused();
        await expect(prompt.getByRole('button', { name: 'Copy message' })).toBeVisible();
        await page.keyboard.press('Alt+ArrowUp');
        const earlierReply = reply('You chose Blue.');
        await expect(earlierReply).toBeFocused();
        await expect(copyOf('Explored the project.')).toHaveCount(0);
        await page.keyboard.press('Tab');
        await expect(earlierReply.getByRole('button', { name: 'Copy message' })).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-reply-keyboard-copy.png') });
        await page.keyboard.press('Enter');
        await expect(earlierReply.getByRole('button', { name: 'Copied' })).toBeVisible();
        // A shell read reads as the file it read, the way the Codex app names exploration.
        const workGroup = chat.getByRole('button', {
            name: 'Read 10 files, ran 1 command, called 1 MCP tool, ran 2 browser steps, ran 1 Computer Use step',
        });
        await expect(workGroup).toHaveAttribute('aria-expanded', 'false');
        await workGroup.click();
        await expect(chat.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
        // A long group scrolls, fading the edge that hides rows.
        const workList = chat.locator('[data-scroll-fade-end]');
        await expect(workList).toHaveCount(1);
        await expectDisclosuresSettled(chat, 'agent-chat-work-group');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-work-list-scroll.png') });
        await workList.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
        await expect(chat.locator('[data-scroll-fade-start]')).toHaveCount(1);
        await expect(chat.locator('[data-scroll-fade-end]')).toHaveCount(0);
        await chat
            .locator('[data-scroll-fade-start]')
            .evaluate((element) => element.scrollTo({ top: 0 }));
        // A Computer Use step reads as the title the Agent wrote for it, with its script and output one click away.
        await expect(chat.getByRole('button', { name: /^Read the router page/u })).toBeVisible();
        await expect(chat.getByRole('button', { name: /^Copy the settings/u })).toBeVisible();
        const browserStep = chat.getByRole('button', { name: /^Open the JSON editor/u });
        await browserStep.click();
        await expect(chat.getByText('await tab.click(12);')).toBeVisible();
        await expect(chat.getByText(/^Browser tab: 1, Title/u).last()).toBeVisible();
        await expectDisclosuresSettled(chat, 'agent-chat-item');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-computer-use.png') });
        await browserStep.click();
        await chat.getByRole('button', { name: 'Read app.ts' }).first().click();
        // A printed file's output is painted in that file's language.
        await expect(chat.locator('pre code span[class*="mtk"]').first()).toBeVisible();
        await expectDisclosuresSettled(chat, 'agent-chat-item');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-work-group.png') });
        const exploreFold = chat.getByRole('button', { name: /^Worked(?: for |$)/u }).last();
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
        await page.getByRole('tab', { name: 'Codex (Chat)', exact: true }).click();
        await expect(message).toBeVisible();

        // A Files entry dropped on the composer is inserted as its path, relative to where the Agent runs.
        await page.getByRole('treeitem', { name: 'app.ts', exact: true }).dragTo(message);
        await expect(message).toHaveValue('src/app.ts ');
        // A path written as plain prose, in the user's message and in the reply, opens in the Editor; the URL shows links' accent.
        await message.fill('see src/greeting.ts:2 next to https://github.com/example/repo');
        await message.press('Enter');
        // The user's message renders it as an inline link so it wraps with the text; the reply renders a button.
        await expect(
            chat.getByRole('link', { name: 'src/greeting.ts:2', exact: true }),
        ).toHaveCount(1);
        const prosePath = chat.getByRole('button', { name: 'src/greeting.ts:2', exact: true });
        await expect(prosePath).toHaveCount(1);
        await page.screenshot({ path: testInfo.outputPath('agent-chat-prose-path.png') });
        await prosePath.click();
        await expect(page.getByRole('tab', { name: 'greeting.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await page.getByRole('tab', { name: 'Codex (Chat)', exact: true }).click();
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
        await chat.getByRole('button', { name: 'New Codex Chat' }).click();
        await expect(chat.getByText('You chose Blue.')).toHaveCount(0);
        await expect(message).toHaveAttribute('placeholder', 'Message Codex');
        // The `+` opens its Agent menu on hover; leave it so only the New Session menu below offers "Codex Chat".
        await page.mouse.move(0, 0);
        await expect(page.getByRole('menu', { name: 'New Codex Chat' })).toHaveCount(0);

        // The sidebar's New Session menu shares the preference, so a whole Session can start as a Chat.
        const previous = await pageRequest<{ selectedSessionId?: string }>(page, 'app.bootstrap');
        const newSession = page.getByRole('button', { name: /^New Session in / });
        // Opened from the keyboard: on the CI runner a synthesized pointer over the sidebar heading lands on `<html>`
        // even though `elementFromPoint` hits the heading, so a hover-then-click never reaches the trigger.
        await newSession.focus();
        await newSession.press('Enter');
        const sessionMenu = page.getByRole('menu', { name: /^New Session in / });
        await expect(
            sessionMenu.getByRole('menuitemcheckbox', { name: 'Open Agents in Chat' }),
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

        // A file-change approval previews each file's colored diff before Apply Changes.
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
        await fileApproval.getByRole('button', { name: 'Apply Changes', exact: true }).click();
        await expect(fileApproval).toHaveCount(0);
        await expect(chat.getByText('The files were changed.')).toBeVisible();

        // The finished turn folds its work behind its duration, keeping the prompt and the reply in view.
        const turnFold = chat.getByRole('button', { name: /^Worked(?: for |$)/u }).last();
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
            .getByRole('button', { name: /^Worked(?: for |$)/u })
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

        // An applied file's path opens it in the Editor; the changes card's icon button shares the link's name.
        await chat
            .getByRole('button', { name: 'Open src/greeting.ts in Editor' })
            .filter({ hasText: 'src/greeting.ts' })
            .click();
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
        await terminalMenu.getByRole('menuitemcheckbox', { name: 'Open Agents in Chat' }).click();
        await chooseTerminalFromCreateMenu(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('hi there');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Codex. You said: hi there')).toBeVisible();

        // Close the Session's shell PTY so the Chat is the only running work.
        const bootstrap = await pageRequest<{
            terminals: Array<{ id: string; surface?: string }>;
        }>(page, 'app.bootstrap', {});
        for (const terminal of bootstrap.terminals) {
            if (terminal.surface === 'chat') continue;
            // eslint-disable-next-line no-await-in-loop -- Serialized closes keep Session focus deterministic.
            await pageRequest(page, 'terminal.close', { terminalId: terminal.id });
        }
        await expect(message).toBeVisible();
        await expect.poll(() => runningWork(page)).toEqual({ terminals: 0, chats: 1 });

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
        ).toBe('Close this window while 1 Chat is running?');
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
