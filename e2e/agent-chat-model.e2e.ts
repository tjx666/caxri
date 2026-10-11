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
test('a Codex Chat switches its model and effort and shows the context it uses', async ({}, testInfo) => {
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

        await picker.click();
        const menu = page.getByRole('menu');
        await expect(menu.getByRole('menuitemradio')).toHaveText([
            /Fake Codex\s*The default fake model/,
            /Fake Codex Mini/,
            'Low',
            /MediumDefault/,
            'High',
        ]);
        await expect(menu.getByRole('menuitemradio', { name: 'Medium' })).toBeChecked();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-model-menu.png') });
        await menu.getByRole('menuitemradio', { name: 'High' }).click();
        await expect(picker).toHaveAccessibleName('Model: Fake Codex, High effort');
        // The menu stays open, so a model switch shows the new model's efforts in place.
        await menu.getByRole('menuitemradio', { name: /Fake Codex Mini/ }).click();
        await expect(picker).toHaveAccessibleName('Model: Fake Codex Mini, Low effort');
        await expect(menu.getByRole('menuitemradio')).toHaveText([
            /Fake Codex\s*The default fake model/,
            /Fake Codex Mini/,
            /LowDefault/,
        ]);
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();

        // A running turn keeps its status row inside the composer card.
        await message.fill('slow please');
        await message.press('Enter');
        await expect(chat.getByText('Esc to stop')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-working-composer.png') });
        await message.press('Escape');
        await expect(chat.getByText('Esc to stop')).toBeHidden();

        await message.fill('hello');
        await message.press('Enter');
        await expect(chat.getByRole('img', { name: '1% of context used' })).toBeVisible();

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
        const menu = page.getByRole('menu');
        const ultracode = menu.getByRole('menuitemcheckbox', { name: /Ultracode/u });
        await expect(ultracode).not.toBeChecked();
        await ultracode.click();
        await expect(ultracode).toBeChecked();
        await menu.getByRole('menuitemradio', { name: 'High' }).click();
        await expect(menu.getByRole('menuitemradio', { name: 'High' })).toBeChecked();
        await expect(ultracode).toBeChecked();
        await page.screenshot({ path: testInfo.outputPath('claude-chat-ultracode-menu.png') });
        await page.keyboard.press('Escape');
        await expect(picker).toHaveAccessibleName('Model: Fake, High effort, ultracode on');
        await page.screenshot({ path: testInfo.outputPath('claude-chat-ultracode-trigger.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
