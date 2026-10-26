import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeClaudeChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    selectedSessionId,
    VISIBLE_SESSION,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat answers side questions beside the conversation and converts them to a Session', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-side-chat-'));
    const directory = await realpath(created);
    const root = join(directory, 'project');
    await mkdir(root);
    const userData = join(directory, 'user-data');
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('main question');
        await message.press('Enter');
        await expect(chat.getByText(/You said: main question/u).last()).toBeVisible();

        // Cmd+; opens the side chat beside the Chat, with its own composer.
        await message.click();
        await page.keyboard.press('Meta+;');
        const sideInput = page.getByRole('textbox', { name: 'Ask a side question' });
        await expect(sideInput).toBeVisible();
        await sideInput.fill('what is a flag?');
        await sideInput.press('Enter');
        await expect(
            page.getByText('Side answer to "what is a flag?" after 0 earlier'),
        ).toBeVisible();

        // A follow-up carries the first exchange as context.
        await sideInput.fill('and another?');
        await sideInput.press('Enter');
        await expect(page.getByText('Side answer to "and another?" after 1 earlier')).toBeVisible();

        // `/btw <question>` in the main composer goes to the side chat, not the main conversation.
        await message.fill('/btw typed aside');
        await message.press('Enter');
        await expect(page.getByText('Side answer to "typed aside" after 2 earlier')).toBeVisible();
        await expect(chat.locator('[data-agent-chat-user-message]')).toHaveCount(1);
        await page.screenshot({ path: testInfo.outputPath('claude-side-chat.png') });

        // Convert to Session opens a new Session whose Chat holds the Q&A.
        const source = await chat.getAttribute('data-workbench-session-id');
        await page.getByRole('button', { name: 'Convert to Session' }).click();
        const converted = page.locator(VISIBLE_SESSION);
        await expect(converted).not.toHaveAttribute('data-workbench-session-id', source ?? '');
        await expect(converted.getByText(/what is a flag\?/u).first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('claude-side-chat-converted.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

test('switching to a Session whose side chat makes the Secondary Sidebar yield keeps keyboard focus on screen', async () => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-side-chat-yield-'));
    const directory = await realpath(created);
    const root = join(directory, 'project');
    await mkdir(root);
    await writeFile(join(root, 'notes.txt'), 'notes\n');
    const userData = join(directory, 'user-data');
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        const secondarySidebar = page.locator('.secondary-sidebar');
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chatSession = await selectedSessionId(page);
        const message = page.locator(VISIBLE_SESSION).getByRole('textbox', { name: 'Message' });
        await message.click();
        await page.keyboard.press('Meta+;');
        await expect(page.getByRole('textbox', { name: 'Ask a side question' })).toBeVisible();
        await expect(secondarySidebar).toHaveCount(0);

        // A Session without the arrangement shows the Secondary Sidebar again; park focus on one of its rows.
        await createAdditionalShellSession(page);
        const row = secondarySidebar.getByRole('treeitem', { name: 'notes.txt' });
        await row.focus();
        await expect(row).toBeFocused();

        // Back to the Chat's Session by shortcut: the yield unmounts the row that owned focus.
        await page.keyboard.press('Control+Alt+ArrowLeft');
        await expect.poll(() => selectedSessionId(page)).toBe(chatSession);
        await expect(secondarySidebar).toHaveCount(0);
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const active = document.activeElement;
                    if (!active || active === document.body) return 'body';
                    return active.checkVisibility() ? 'visible' : 'hidden';
                }),
            )
            .toBe('visible');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
