import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectComposerValue } from './support/agent-chat-composer.ts';
import {
    fakeClaudeChatAgentMode,
    fakeCodexChatAgentMode,
    openAgentChat,
} from './support/agent-chat-fixture.ts';
import { openBackgroundWork } from './support/agent-chat-status-row.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

/**
 * A temporary Project root and profile with the chosen fake Agent provider.
 */
async function fixture(prefix: string, provider: 'claude' | 'codex') {
    const temporary = await mkdtemp(join(tmpdir(), prefix));
    const directory = await realpath(temporary);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode =
        provider === 'codex'
            ? await fakeCodexChatAgentMode(directory, userData)
            : await fakeClaudeChatAgentMode(userData);
    return { directory, agentMode, userData, root };
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat opens a subagent and a background shell beside the Chat', async ({}, testInfo) => {
    const { directory, agentMode, userData, root } = await fixture(
        'caxri-agent-chat-tasks-',
        'codex',
    );
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });

        await message.fill('start a subagent hold');
        await message.press('Enter');
        // The status row's Background work popover lists the running subagent.
        const strip = await openBackgroundWork(page, chat);
        const openSubagent = strip.getByRole('button', { name: /^Open Inspect the fixtures/u });
        await expect(openSubagent).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-subagent-strip.png') });

        await openSubagent.click();
        const subagent = page.getByRole('region', { name: /Inspect the fixtures/u });
        await expect(subagent).toBeVisible();
        // `ls fixtures` reads as the listing it is, the same as in the Chat's own timeline: its work group sums it up
        // as a listing and opens to the command's own row.
        const work = subagent.getByRole('button', { name: /^Listed 1 folder/u });
        await expect(work).toBeVisible();
        await work.click();
        await expect(subagent.getByRole('button', { name: /^Listed fixtures/u })).toBeVisible();
        await expect(subagent.getByText(/still working/u).first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-subagent-tab.png') });
        await subagent.getByRole('button', { name: 'Stop' }).click();
        await expect(subagent.getByRole('button', { name: 'Stop' })).toHaveCount(0);

        await message.fill('run it in the background');
        await message.press('Enter');
        await expect(chat.getByText('The dev server is running in the background.')).toBeVisible();
        await (
            await openBackgroundWork(page, chat)
        )
            .getByRole('button', { name: /^Open .*bun run dev/u })
            .click();
        const shell = page.getByRole('region', { name: /bun run dev/u });
        await expect(shell.getByText(/tick \d+/u).first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-shell-tab.png') });
        await shell.getByRole('button', { name: 'Stop' }).click();
        await expect(shell.getByRole('button', { name: 'Stop' })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('codex-shell-stopped.png') });

        // A wait names the subagent it waited for by its Background work title, as the Codex TUI does.
        await message.fill('use a subagent');
        await message.press('Enter');
        await expect(chat.getByText('The helper finished.')).toBeVisible();
        await chat
            .getByRole('button', { name: /^Worked(?: for |$)/u })
            .last()
            .click();
        await expect(
            chat.getByRole('button', { name: 'Waited for Inspect the fixtures' }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-subagent-wait.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat queues follow-ups during a turn, sends them as one turn, and steers on request or on an empty Enter', async ({}, testInfo) => {
    const { directory, agentMode, userData, root } = await fixture(
        'caxri-agent-chat-queue-',
        'codex',
    );
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });

        await message.fill('slow please');
        await message.press('Enter');
        await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        await message.fill('hello after this');
        await expect(chat.getByRole('button', { name: 'Queue message' })).toBeVisible();
        await message.press('Enter');
        // The message leaves the composer at once, before Server Core answers.
        await expectComposerValue(message, '');
        const queue = chat.getByRole('region', { name: 'Queued messages' });
        await expect(queue.getByText('hello after this')).toBeVisible();
        await message.fill('hello second');
        await message.press('Enter');
        await expect(queue.getByText('hello second')).toBeVisible();
        await message.fill('hello third');
        await message.press('Enter');
        await expect(queue.getByText('hello third')).toBeVisible();
        await message.fill('hello edit');
        await message.press('Enter');
        await expect(queue.getByText('hello edit')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-queue.png') });

        // A steer the provider refuses gives the message back to the composer instead of losing it, and says why.
        allowE2EErrors([{ source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 }]);
        await message.fill('hello refuse');
        await message.press('ControlOrMeta+Enter');
        await expectComposerValue(message, 'hello refuse');
        await expect(chat.locator('[data-agent-chat-pending]')).toHaveCount(0);
        await message.fill('hello steer');
        // Holding the steer modifier turns Send into Steer before Enter is pressed.
        await page.keyboard.down('ControlOrMeta');
        await expect(chat.getByRole('button', { name: 'Steer', exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-steer-held.png') });
        await page.keyboard.press('Enter');
        await page.keyboard.up('ControlOrMeta');
        await expect(chat.getByText('Steered')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-steered.png') });

        await chat.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(chat.getByText('Queue paused')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-queue-paused.png') });
        // Editing takes the message out of the queue and back into the empty composer.
        await queue.getByRole('button', { name: 'More actions for queued message' }).last().click();
        await page.getByRole('menuitem', { name: 'Edit' }).click();
        await expectComposerValue(message, 'hello edit');
        await expect(queue.getByText('hello edit')).toHaveCount(0);
        await message.fill('');
        await queue.getByRole('button', { name: 'Delete queued message' }).last().click();
        await expect(queue.getByText('hello third')).toHaveCount(0);
        // Undo in the toast puts the deleted message back where it was, not at the end.
        await queue.getByRole('button', { name: 'Delete queued message' }).first().click();
        await expect(queue.getByText('hello after this')).toHaveCount(0);
        await page.screenshot({
            path: testInfo.outputPath('codex-queue-undo.png'),
            animations: 'disabled',
        });
        await page
            .locator('[data-sonner-toast]')
            .getByRole('button', { name: 'Undo', exact: true })
            .click();
        await expect(queue.getByRole('listitem')).toHaveCount(2);
        await expect(queue.getByRole('listitem')).toContainText([
            'hello after this',
            'hello second',
        ]);
        await chat.getByRole('button', { name: 'Resume' }).click();
        // The two messages left in the queue go out together, as one message and one turn.
        await expect(
            chat.getByText('Hello from fake Codex. You said: hello after this'),
        ).toBeVisible();
        await expect(queue).toHaveCount(0);
        await expect(
            chat.locator('[data-agent-chat-user-message]').filter({ hasText: 'hello after this' }),
        ).toContainText('hello second');
        // A queued message reads as an ordinary one once delivered; only a steered message keeps a caption.
        await expect(chat.getByText('Queued', { exact: true })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('codex-queue-drained.png') });

        // With nothing typed, Enter steers the queued message into the running turn, as the placeholder says.
        await message.fill('slow please');
        await message.press('Enter');
        await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        await message.fill('hello fourth');
        await message.press('Enter');
        await expect(queue.getByText('hello fourth')).toBeVisible();
        await expect(message).toHaveAttribute(
            'aria-placeholder',
            'Enter to steer the first queued message',
        );
        // The row's actions show without hovering it, as the Codex app's queue rows do.
        await page.mouse.move(0, 0);
        const fourthRow = queue.getByRole('listitem').filter({ hasText: 'hello fourth' });
        await expect(fourthRow.getByRole('button', { name: 'Steer now' })).toBeVisible();
        await expect(
            fourthRow.getByRole('button', { name: 'Delete queued message' }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-queue-empty-enter.png') });
        await message.press('Enter');
        await expect(queue).toHaveCount(0);
        await expect(chat.getByText('Steered')).toHaveCount(2);
        await expect(
            chat.locator('[data-agent-chat-user-message]').filter({ hasText: 'hello fourth' }),
        ).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat reopens a finished subagent and stops a background shell', async ({}, testInfo) => {
    const { directory, agentMode, userData, root } = await fixture(
        'caxri-claude-chat-tasks-',
        'claude',
    );
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });

        await message.fill('use a subagent');
        await message.press('Enter');
        await expect(chat.getByText('The subagent finished.')).toBeVisible();
        // A finished subagent leaves the strip; the folded turn's row still opens it without being expanded.
        const fold = chat.getByRole('button', { name: /^Worked(?: for |$)/u }).first();
        await expect(fold).toHaveAttribute('aria-expanded', 'false');
        await page.screenshot({ path: testInfo.outputPath('claude-turn-subagent-entry.png') });
        await chat.getByRole('button', { name: 'Open subagent Survey the project' }).click();
        await expect(fold).toHaveAttribute('aria-expanded', 'false');
        const subagent = page.getByRole('region', { name: 'Survey the project' });
        await expect(subagent.getByText('Found a README.').first()).toBeVisible();
        // Priced from the subagent's own transcript, not the provider's latest-request token count.
        await expect(subagent.getByText(/66\.9k tokens · \$0\.\d\d · 1 tool use/u)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-subagent-tab.png') });

        await message.fill('run in background');
        await message.press('Enter');
        const strip = await openBackgroundWork(page, chat);
        await strip.getByRole('button', { name: /^Open / }).click();
        // The Bash call's description names the shell; its tab still shows the command line above the output.
        await expect(
            (await openBackgroundWork(page, chat)).getByRole('button', {
                name: 'Open Print ticks',
            }),
        ).toBeVisible();
        const shell = page.getByRole('region', { name: 'Print ticks' });
        await expect(shell.getByText(/^\$ while true/u)).toBeVisible();
        await expect(shell.getByText(/tick \d+/u).first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-shell-tab.png') });
        await strip.getByRole('button', { name: /^Stop / }).click();
        // The status row is live status: it folds away, popover and all, once nothing runs.
        await expect(chat.locator('[data-agent-chat-status-row]')).toHaveCount(0);
        await expect(strip).toHaveCount(0);
        await expect(shell.getByRole('button', { name: 'Stop' })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('claude-shell-stopped.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
