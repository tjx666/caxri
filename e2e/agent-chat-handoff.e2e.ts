import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectComposerValue } from './support/agent-chat-composer.ts';
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
test('an expired Claude Code Chat continues in a new Chat that reads its transcript', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-claude-handoff-'));
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
        // The effort shows once Claude Code has started, so Enter below sends instead of racing the launch.
        await expect(
            chat.getByRole('button', { name: 'Model: Default, Medium effort', exact: true }),
        ).toBeVisible();
        // A cache notice needs a context worth re-reading (`isAgentChatCacheRewriteNoticeable`); the fake Claude reports
        // 140k cached tokens for a turn that mentions a large context.
        await message.fill('hi there, large context');
        await message.press('Enter');
        await expect(
            chat.getByText('Hello from fake Claude. You said: hi there, large context'),
        ).toBeVisible();

        /*
         * Only the Renderer's wall clock moves past the one-hour cache lifetime; the fake Claude keeps real time. This
         * overrides `Date.now` alone instead of `page.clock.install()`, which would also fake the animation frames and
         * `performance.now` that the new tab's enter animation runs on. The minute tick is still an hour away, so typing
         * the draft is what re-renders the notice against the shifted time.
         */
        await page.evaluate(() => {
            const realNow = Date.now.bind(Date);
            Date.now = () => realNow() + 61 * 60_000;
        });
        await message.fill('also add a test');
        await expect(
            chat.getByText(/^Idle .* · next reply re-reads the whole conversation/u),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-cache-expired.png') });

        await chat.getByRole('button', { name: 'Continue in new Chat' }).click();
        // The new Chat opens as the selected tab and its first message points at the previous transcript.
        const handoff = chat.getByText(
            /^Continue the unfinished work from a previous Agent conversation/u,
        );
        await expect(handoff).toBeVisible();
        // A typed path in a sent message renders as a path pill that shows the file name only.
        await expect(chat.getByText('Previous transcript:')).toBeVisible();
        await expect(chat.getByText(/^[\w-]+\.jsonl$/u)).toBeVisible();
        // The long handoff message is clamped; the user's draft sits below the fold.
        await chat.getByRole('button', { name: 'Show more' }).click();
        await expect(chat.getByText(/after catching up:\s*also add a test/u)).toBeVisible();
        // The fake Claude answers a prompt that asks for a subagent by running one.
        await expect(chat.getByText('The subagent finished.')).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Claude (Chat)' })).toHaveCount(2);
        await expect(page.getByRole('tab', { name: 'Claude (Chat)' }).last()).toHaveAttribute(
            'aria-selected',
            'true',
        );
        // The draft went with the handoff, so the expired Chat no longer holds it.
        await page.getByRole('tab', { name: 'Claude (Chat)' }).first().click();
        await expect(
            chat.getByText('Hello from fake Claude. You said: hi there, large context'),
        ).toBeVisible();
        await expectComposerValue(message, '');
        await page.getByRole('tab', { name: 'Claude (Chat)' }).last().click();
        await expect(chat.getByText('The subagent finished.')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-handoff.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
