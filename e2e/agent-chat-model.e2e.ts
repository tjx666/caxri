import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat switches its model, effort, and Fast mode and shows the context it uses', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-model-'));
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
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        const picker = chat.getByRole('button', { name: /^Model: / });
        await expect(picker).toHaveAccessibleName('Model: Fake Codex, Medium effort');

        // `Cmd+/` opens the picker from the composer, and Escape hands focus back to it.
        await message.focus();
        await page.keyboard.press('Meta+/');
        // It starts on the current choice, so the arrows adjust the effort right away.
        await expect(
            page.getByRole('dialog').getByRole('slider', { name: 'Reasoning effort' }),
        ).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-model-shortcut.png') });
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toBeHidden();
        await expect(message).toBeFocused();

        // The picker opens on the effort: a slider with one stop per effort, titled with the effort over the model.
        await picker.click();
        const panel = page.getByRole('dialog');
        const effort = panel.getByRole('slider', { name: 'Reasoning effort' });
        await expect(effort).toHaveAttribute('aria-valuetext', 'Medium');
        // The pill keeps naming the current choice while open, so it never resizes under the pointer.
        await expect(picker).toHaveText(/Fake Codex/u);
        await page.screenshot({ path: testInfo.outputPath('codex-chat-model-menu.png') });
        await effort.press('ArrowRight');
        await expect(picker).toHaveAccessibleName('Model: Fake Codex, High effort');
        // Changing the effort keeps the panel open; Fast mode is a bolt toggle in its header.
        const fast = panel.getByRole('button', { name: 'Fast', exact: true });
        await expect(fast).toHaveAttribute('aria-pressed', 'false');
        await fast.click();
        await expect(fast).toHaveAttribute('aria-pressed', 'true');
        await page.screenshot({ path: testInfo.outputPath('codex-chat-fast-menu.png') });
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await expect(picker).toHaveAccessibleName('Model: Fake Codex, High effort, Fast mode on');
        await page.screenshot({ path: testInfo.outputPath('codex-chat-fast-trigger.png') });
        // The model name opens the model list; a model without Fast mode turns it off and drops the toggle, and
        // choosing a model with an effort returns to the effort panel.
        await picker.click();
        await panel.getByRole('button', { name: 'Fake Codex, choose model' }).click();
        await expect(panel.getByRole('radio')).toHaveText(['Fake Codex', 'Fake Codex Mini']);
        await expect(panel.getByRole('radio', { name: 'Fake Codex', exact: true })).toBeChecked();
        await panel.getByRole('radio', { name: 'Fake Codex Mini' }).click();
        await expect(picker).toHaveAccessibleName('Model: Fake Codex Mini, Low effort');
        // Its one effort leaves nothing to slide between, so the panel keeps only its header.
        await expect(
            panel.getByRole('button', { name: 'Fake Codex Mini, choose model' }),
        ).toBeVisible();
        await expect(effort).toHaveCount(0);
        await expect(fast).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();

        // A running turn shows its status row in the strip on top of the composer card, not inside it.
        await message.fill('slow reconnect please');
        await message.press('Enter');
        await expect(
            chat.locator('[data-agent-chat-composer-strip]').getByText('Esc to stop'),
        ).toBeVisible();
        // A dropped stream reads as a warning row naming the cause and the attempt, with Codex's detail beneath.
        const retry = chat
            .getByRole('status')
            .filter({ hasText: 'Connection lost, retrying (2/5)' });
        await expect(retry).toBeVisible();
        await expect(retry).toContainText('stream disconnected before completion');
        await expect(chat.locator('form').getByText('Esc to stop')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('codex-chat-working-composer.png') });
        await message.press('Escape');
        await expect(chat.getByText('Esc to stop')).toBeHidden();

        await message.fill('hello');
        await message.press('Enter');
        await expect(chat.getByRole('meter', { name: /^1% of context used, /u })).toBeVisible();

        await message.fill('table');
        await message.press('Enter');
        const guide = chat.getByRole('button', { name: 'the Markdown guide' });
        const faq = chat.getByRole('button', { name: 'https://example.com/faq' });
        const issue = chat.getByRole('button', { name: 'the tracking issue' });
        await expect(guide).toBeVisible();
        await expect(faq).toBeVisible();
        // Both link forms lead with an icon kept out of the accessible name: GitHub's mark, else the site's icon or a globe.
        await expect(issue.locator('[data-link-icon="github"]')).toBeVisible();
        await expect(guide.locator('[data-link-icon]')).toHaveCount(1);
        await expect(faq.locator('[data-link-icon]')).toHaveCount(1);
        await expect(chat.getByText('Esc to stop')).toBeHidden();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-markdown.png') });
        // A quote offers Copy on hover, the way a code block does.
        const quote = chat.locator('blockquote').filter({ hasText: 'nothing outside the Project' });
        const copyQuote = quote.locator('..').getByRole('button', { name: 'Copy quote' });
        await expect(copyQuote).toHaveCSS('opacity', '0');
        await quote.hover();
        await expect(copyQuote).toHaveCSS('opacity', '1');
        await page.screenshot({ path: testInfo.outputPath('codex-chat-quote-copy.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat turns ultracode on beside the effort and keeps it through an effort change', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-model-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('hello');
        await message.press('Enter');
        await expect(chat.getByText(/You said: hello/u)).toBeVisible();

        const picker = chat.getByRole('button', { name: /^Model: / });
        await picker.click();
        const panel = page.getByRole('dialog');
        const ultracode = panel.getByRole('button', { name: 'Ultracode', exact: true });
        await expect(ultracode).toHaveAttribute('aria-pressed', 'false');
        await ultracode.click();
        await expect(ultracode).toHaveAttribute('aria-pressed', 'true');
        const effort = panel.getByRole('slider', { name: 'Reasoning effort' });
        await effort.press('ArrowRight');
        await expect(effort).toHaveAttribute('aria-valuetext', 'High');
        await expect(ultracode).toHaveAttribute('aria-pressed', 'true');
        await page.screenshot({ path: testInfo.outputPath('claude-chat-ultracode-menu.png') });
        await page.keyboard.press('Escape');
        await expect(picker).toHaveAccessibleName('Model: Fake, High effort, ultracode on');
        await page.screenshot({ path: testInfo.outputPath('claude-chat-ultracode-trigger.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
