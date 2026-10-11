import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

/**
 * The text each find highlight paints, read from the CSS Custom Highlight registry: the matches are ranges, not
 * elements, so no locator reaches them.
 */
async function highlightedText(page: Page, name: string): Promise<string[]> {
    return page.evaluate(
        (highlight) =>
            [...(CSS.highlights.get(highlight) ?? [])].map((range) =>
                range instanceof Range ? range.toString() : '',
            ),
        name,
    );
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Cmd+F finds text in a Chat, steps through matches, and opens a folded turn that holds one', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-find-'));
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
        const session = page.locator(VISIBLE_SESSION);
        const message = session.getByRole('textbox', { name: 'Message' });
        const send = async (text: string, reply: string): Promise<void> => {
            await message.fill(text);
            await message.press('Enter');
            await expect(session.getByText(reply)).toBeVisible();
        };
        await send('alpha one', 'You said: alpha one');
        await send('alpha two', 'You said: alpha two');
        await send('explore the project', 'Explored the project.');
        const fold = session.getByRole('button', { name: /^Worked(?: for |$)/u }).last();
        await expect(fold).toHaveAttribute('aria-expanded', 'false');

        await message.focus();
        await page.keyboard.press('Meta+f');
        const find = session.getByRole('search', { name: 'Find in Chat' });
        const input = find.getByRole('textbox', { name: 'Find in Chat' });
        await expect(input).toBeFocused();

        // Each message and its echoed reply mention the query: four matches, the first one current.
        await input.fill('ALPHA');
        await expect(find.getByText('1/4')).toBeVisible();
        await expect.poll(() => highlightedText(page, 'agent-chat-find-active')).toEqual(['alpha']);
        await expect
            .poll(async () => (await highlightedText(page, 'agent-chat-find')).length)
            .toBe(3);
        await page.screenshot({ path: testInfo.outputPath('agent-chat-find.png') });
        await input.press('Enter');
        await expect(find.getByText('2/4')).toBeVisible();
        await input.press('Shift+Enter');
        await input.press('Shift+Enter');
        await expect(find.getByText('4/4')).toBeVisible();

        await input.fill('zzz');
        await expect(find.getByText('0/0')).toBeVisible();
        await expect(find.getByRole('button', { name: 'Next match' })).toBeDisabled();

        // Commentary folded into a finished turn is not in the DOM until find opens its fold.
        await input.fill('looking around');
        await expect(fold).toHaveAttribute('aria-expanded', 'true');
        await expect(find.getByText('1/1')).toBeVisible();
        await expect
            .poll(() => highlightedText(page, 'agent-chat-find-active'))
            .toEqual(['Looking around']);
        await expect(session.getByRole('navigation', { name: 'Messages' })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-find-fold.png') });

        // A refined query that no longer matches folds the turn back; closing leaves it where the reader landed.
        await input.fill('looking aroundx');
        await expect(fold).toHaveAttribute('aria-expanded', 'false');
        await input.fill('looking around');
        await expect(fold).toHaveAttribute('aria-expanded', 'true');
        await input.press('Escape');
        await expect(find).toHaveCount(0);
        await expect(fold).toHaveAttribute('aria-expanded', 'true');
        await expect(message).toBeFocused();
        await expect.poll(() => highlightedText(page, 'agent-chat-find')).toEqual([]);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
