import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';

async function launchWithChat(options: { preserveHostOnClose?: boolean } = {}) {
    const created = await mkdtemp(join(tmpdir(), 'caxri-session-return-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const launchOptions = { agentMode, userDataDir: userData, testRootPath: root, ...options };
    const running = await launchCaxri(launchOptions);
    return { directory, launchOptions, running };
}

/**
 * Runs two Codex Chat turns while another Session is selected, leaving that other Session selected. Returns the Chat's
 * Session.
 */
async function finishTwoTurnsAway(page: Page): Promise<string> {
    const chatId = await createProjectSession(page, 'shell');
    await openAgentChat(page, 'Codex Chat');
    const message = page.locator(VISIBLE_SESSION).getByRole('textbox', { name: 'Message' });
    await message.fill('longstream please');
    await message.press('Enter');
    // A follow-up sent during the turn queues and runs as a second turn.
    await message.fill('hello after this');
    await message.press('Enter');
    await createAdditionalShellSession(page);
    const state = await pageRequest<BootstrapState>(page, 'app.bootstrap');
    const chatTerminal = state.terminals.find(
        ({ sessionId, provider }) => sessionId === chatId && provider === 'codex',
    );
    if (!chatTerminal) throw new Error('Chat Terminal missing');
    // Both turns end while another Session is selected.
    await expect
        .poll(
            async () => {
                const snapshot = await pageRequest<{
                    turns: Array<{ status: string }>;
                    queue?: unknown[];
                }>(page, 'agentChat.read', { terminalId: chatTerminal.id });
                return {
                    completed: snapshot.turns.filter(({ status }) => status === 'completed').length,
                    queued: snapshot.queue?.length ?? 0,
                };
            },
            { timeout: 60_000 },
        )
        .toEqual({ completed: 2, queued: 0 });
    return chatId;
}

/**
 * Runs two Codex Chat turns while another Session is selected, then returns to the Chat.
 */
async function returnAfterTwoTurns(page: Page): Promise<void> {
    await sessionCard(page, await finishTwoTurnsAway(page)).click();
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('returning to a Chat counts the turns that finished while away', async ({}, testInfo) => {
    const { directory, running } = await launchWithChat();
    try {
        const { page } = running;
        await returnAfterTwoTurns(page);
        const hint = page.getByRole('status').filter({ hasText: 'new replies' });
        await expect(hint).toContainText('2 new replies');
        const jumpToLatest = page
            .locator(VISIBLE_SESSION)
            .getByRole('button', { name: 'Jump to latest' });
        // The hint holds the bottom slot near the composer while Jump to latest has nothing to do.
        await expect(jumpToLatest).toHaveCSS('opacity', '0');
        const transcript = page.locator(VISIBLE_SESSION).getByRole('log');
        const [hintBox, transcriptBox] = await Promise.all([
            hint.boundingBox(),
            transcript.boundingBox(),
        ]);
        expect(hintBox!.y).toBeGreaterThanOrEqual(transcriptBox!.y + transcriptBox!.height - 1);
        await page.screenshot({ path: testInfo.outputPath('return-hint.png') });
        // The whole message jumps, not only its trailing words.
        await hint.getByText('2 new replies').hover();
        await page.screenshot({ path: testInfo.outputPath('return-hint-hover.png') });
        await hint.getByText('2 new replies').click();
        await expect(hint).toBeHidden();
        // Up at the first missed prompt, Jump to latest takes the same slot.
        await expect(jumpToLatest).toHaveCSS('opacity', '1');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('scrolling up from the return hint settles instead of shaking', async ({}) => {
    const { directory, running } = await launchWithChat();
    try {
        const { page } = running;
        await returnAfterTwoTurns(page);
        const hint = page.getByRole('status').filter({ hasText: 'new replies' });
        await expect(hint).toContainText('2 new replies');
        const transcript = page.locator(VISIBLE_SESSION).getByRole('log');
        /**
         * Scrolls the transcript up by `delta` and counts how often the view resized over the next second. The
         * observer's first callback reports the initial size, so a view that holds still reports 1.
         */
        const scrollUp = (delta: number) =>
            transcript.evaluate(async (view, by) => {
                let count = 0;
                const observer = new ResizeObserver(() => {
                    count += 1;
                });
                observer.observe(view);
                view.scrollTop -= by;
                await new Promise((resolve) => setTimeout(resolve, 1000));
                observer.disconnect();
                return count;
            }, delta);
        // A scroll just past the follow threshold but inside the band the hint reserves used to hide the hint, give
        // the view its band back, bring the latest entry into view, and show the hint again, so the view shook.
        expect(await scrollUp(32)).toBe(1);
        await expect(hint).toBeVisible();
        // Scrolling on past the latest entry hides the hint once and lets the view keep its full height.
        expect(await scrollUp(300)).toBe(2);
        await expect(hint).toBeHidden();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('sending a message retires the return hint', async ({}) => {
    const { directory, running } = await launchWithChat();
    try {
        const { page } = running;
        await returnAfterTwoTurns(page);
        const hint = page.getByRole('status').filter({ hasText: 'new replies' });
        await expect(hint).toContainText('2 new replies');
        const message = page.locator(VISIBLE_SESSION).getByRole('textbox', { name: 'Message' });
        await message.fill('hello again');
        await message.press('Enter');
        await expect(hint).toBeHidden();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the return hint survives a Desktop restart', async ({}, testInfo) => {
    // Server Core keeps the Chat's turns across the restart; only the boundary has to be durable.
    const { directory, launchOptions, running } = await launchWithChat({
        preserveHostOnClose: true,
    });
    let second: Awaited<ReturnType<typeof launchCaxri>> | undefined;
    try {
        const chatId = await finishTwoTurnsAway(running.page);
        await running.app.close();

        // The second launch stops Server Core when it closes, so the test leaves nothing running.
        second = await launchCaxri({ ...launchOptions, preserveHostOnClose: false });
        await sessionCard(second.page, chatId).click();
        const hint = second.page.getByRole('status').filter({ hasText: 'new replies' });
        await expect(hint).toContainText('2 new replies');
        await second.page.screenshot({
            path: testInfo.outputPath('return-hint-after-restart.png'),
        });
    } finally {
        if (second) await closeAppQuietly(second.app);
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
