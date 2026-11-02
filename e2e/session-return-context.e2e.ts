import { rm } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';
import { closeAppQuietly, sessionCard, VISIBLE_SESSION } from './support/helpers.ts';
import { finishTwoTurnsAway, launchWithChat } from './support/session-return-fixture.ts';

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
        // The slot kept after the transcript holds the hint below the last line instead of over it.
        const content = page
            .locator(VISIBLE_SESSION)
            .getByRole('log')
            .locator(':scope > div')
            .first();
        const [hintBox, contentBox] = await Promise.all([
            hint.boundingBox(),
            content.boundingBox(),
        ]);
        expect(hintBox!.y).toBeGreaterThanOrEqual(contentBox!.y + contentBox!.height - 1);
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
         * observer's first callback reports the initial size, so a view that holds still reports 1. With `hintLeaves`,
         * that second starts once the hint is gone, since a slow runner can hide it after a fixed second ran out.
         */
        const scrollUp = (delta: number, shouldAwaitHintExit = false) =>
            transcript.evaluate(
                async (view, { by, shouldAwaitHintExit: isAwaitingHintExit }) => {
                    let count = 0;
                    const observer = new ResizeObserver(() => {
                        count += 1;
                    });
                    observer.observe(view);
                    view.scrollTop -= by;
                    const isHintShown = () =>
                        [...document.querySelectorAll('[role="status"]')].some(
                            (node) =>
                                node.textContent.includes('new replies') && node.checkVisibility(),
                        );
                    await new Promise<void>((resolve) => {
                        const startedAt = performance.now();
                        const timer = setInterval(() => {
                            if (
                                isAwaitingHintExit &&
                                isHintShown() &&
                                performance.now() - startedAt < 10_000
                            )
                                return;
                            clearInterval(timer);
                            resolve();
                        }, 50);
                    });
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    observer.disconnect();
                    return count;
                },
                { by: delta, shouldAwaitHintExit },
            );
        // A scroll just past the follow threshold but inside the band the hint reserves used to hide the hint, give
        // the view its band back, bring the latest entry into view, and show the hint again, so the view shook.
        expect(await scrollUp(32)).toBe(1);
        await expect(hint).toBeVisible();
        // Scrolling on past the latest entry hides the hint, and the view keeps its size throughout.
        expect(await scrollUp(300, true)).toBe(1);
        await expect(hint).toBeHidden();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('closing the return hint at the latest entry leaves the transcript still', async ({}) => {
    const { directory, running } = await launchWithChat();
    try {
        const { page } = running;
        await returnAfterTwoTurns(page);
        const hint = page.getByRole('status').filter({ hasText: 'new replies' });
        await expect(hint).toContainText('2 new replies');
        const transcript = page.locator(VISIBLE_SESSION).getByRole('log');
        const read = () =>
            transcript.evaluate((view) => ({
                scrollTop: view.scrollTop,
                viewHeight: view.clientHeight,
            }));
        const before = await read();
        await hint.getByRole('button', { name: 'Dismiss' }).click();
        await expect(hint).toBeHidden();
        // The view used to regain the hint's room as the hint left, which clamped its offset and dropped the transcript.
        expect(await read()).toEqual(before);
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
