import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { highlightedText, isActiveFindMatchInView } from './support/agent-chat-find.ts';
import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

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

        // A new query starts at the first match at or below the top of the view. The latest turn is pinned to the
        // top, so every earlier match sits above it and the last one becomes current.
        await input.fill('ALPHA');
        await expect(find.getByText('4/4')).toBeVisible();

        // Each message and its echoed reply mention the query: four matches. From the top of the conversation the
        // first one is current.
        await input.fill('');
        await session
            .getByRole('log', { name: 'Conversation' })
            .evaluate((element) => element.scrollTo({ top: 0 }));
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
        await expect(find.getByText('No results')).toBeVisible();
        await expect(find.getByRole('button', { name: 'Next Match' })).toBeDisabled();

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

        // Only matches near the view are highlighted, so a match far below it must still become current and scroll into
        // view when stepped to. A tall middle reply keeps the first and last matches several screens apart, so stepping
        // through all four jumps to matches that were outside the highlighted window.
        const filler = Array.from({ length: 60 }, (_, index) => `filler ${index}`).join('\n\n');
        await send('omega first', 'You said: omega first');
        await send(filler, 'You said: filler 0');
        await send('omega last', 'You said: omega last');
        // A running turn follows its tail and would scroll the view back down after each jump.
        await expect(session.getByRole('button', { name: 'Stop' })).toHaveCount(0);
        await message.focus();
        await page.keyboard.press('Meta+f');
        await input.fill('omega');
        await expect(find.getByText(/^\d\/4$/u)).toBeVisible();
        const log = session.getByRole('log', { name: 'Conversation' });
        await log.evaluate((element) => element.scrollTo({ top: 0 }));
        const stepToVisibleMatch = async (): Promise<void> => {
            await input.press('Enter');
            await expect.poll(() => isActiveFindMatchInView(page)).toBe(true);
            await expect
                .poll(() => highlightedText(page, 'agent-chat-find-active'))
                .toEqual(['omega']);
        };
        await stepToVisibleMatch();
        await stepToVisibleMatch();
        await stepToVisibleMatch();
        await stepToVisibleMatch();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
