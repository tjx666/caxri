import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

const LIST = '[data-agent-chat-rail-list]';

/**
 * Three messages of clearly different lengths, so their ticks differ. Each avoids the fake Codex's scenario words
 * (`fail`, `slow`, `ask`, ...), so every one gets the default quoted reply.
 */
const MESSAGES = [
    'Fix the flaky build\nIt breaks on CI about once in ten runs.',
    `Summarize ${Array.from({ length: 40 }, (_, index) => `topic${index}`).join(' ')}`,
    'Thanks',
];

async function box(locator: Locator) {
    const bounds = await locator.boundingBox();
    if (!bounds) throw new Error('Expected a visible element');
    return bounds;
}

/**
 * Where the transcript's text ends: its centered column's right edge minus the column's right padding. With
 * `shouldIgnoreScrollbar`, a classic scrollbar's width is added back as half of it: the column is centered in the log's
 * client width, so a layout-taking scrollbar (hosted macOS runners have no pointing device and show legacy scrollbars,
 * unlike the overlay ones on a developer machine) shifts it left by half the bar once the transcript overflows, which
 * is not the rail moving the transcript.
 */
function contentRight(log: Locator, shouldIgnoreScrollbar = false): Promise<number> {
    return log.evaluate((element, isScrollbarIgnored) => {
        const column = element.firstElementChild;
        if (!(column instanceof HTMLElement)) throw new Error('Expected a transcript column');
        const scrollbarShift =
            isScrollbarIgnored && element instanceof HTMLElement
                ? (element.offsetWidth - element.clientWidth) / 2
                : 0;
        return (
            column.getBoundingClientRect().right -
            Number(getComputedStyle(column).paddingRight.replace('px', '')) +
            scrollbarShift
        );
    }, shouldIgnoreScrollbar);
}

/**
 * Presses Shift+Tab until a row of the rail's list has focus, at most `remaining` times, so the list is reached the way
 * a keyboard user reaches it rather than by focusing a row from script.
 */
async function shiftTabToRail(page: Page, remaining: number): Promise<void> {
    const isRow = await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-agent-chat-rail-row'),
    );
    if (isRow || remaining === 0) return;
    await page.keyboard.press('Shift+Tab');
    await shiftTabToRail(page, remaining - 1);
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('The message rail sketches the conversation at the right edge and lists every message on hover and from the keyboard', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-rail-'));
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
        const send = async (text: string, reply: RegExp) => {
            await message.fill(text);
            await message.press('Enter');
            await expect(chat.getByText(reply).first()).toBeVisible({ timeout: 30_000 });
        };
        const setWindowWidth = (width: number) =>
            running.app.evaluate(({ BrowserWindow }, nextWidth) => {
                const window = BrowserWindow.getAllWindows()[0];
                window.setBounds({ ...window.getBounds(), width: nextWidth });
            }, width);
        await setWindowWidth(1800);
        await send(MESSAGES[0], /You said: Fix the flaky build/u);
        const log = chat.getByRole('log');
        const transcriptRight = (shouldIgnoreScrollbar = false) =>
            contentRight(log, shouldIgnoreScrollbar);
        const rightWithoutRail = await transcriptRight(true);
        await send(MESSAGES[1], /You said: Summarize topic0/u);
        await send(MESSAGES[2], /You said: Thanks/u);
        const rail = chat.getByRole('navigation', { name: 'Messages' });
        const ticks = rail.locator('[data-agent-chat-rail-ticks] > div > span');
        const list = rail.locator(LIST);
        const rows = list.getByRole('button');
        await expect(ticks).toHaveCount(3);
        await expect(rows).toHaveCount(3);

        // The ticks stay in sight at the right edge, each as long as its message is long, the one being read dark.
        await expect(rail.locator('[data-agent-chat-rail-ticks]')).toHaveCSS('opacity', '1');
        const logBox = await box(log);
        expect((await box(ticks.nth(0))).x).toBeGreaterThan(logBox.x + logBox.width / 2);
        const widths = await Promise.all(
            [0, 1, 2].map(async (index) => (await box(ticks.nth(index))).width),
        );
        expect(widths[1]).toBeGreaterThan(widths[0]);
        expect(widths[0]).toBeGreaterThan(widths[2]);
        await expect(list).toHaveAttribute('data-state', 'closed');
        await expect(rows.nth(2)).toHaveAttribute('aria-current', 'location');
        await page.screenshot({ path: testInfo.outputPath('rail-ticks.png') });

        // A wide Chat's centered column already clears the rail, so its appearing never moves the transcript.
        expect(await transcriptRight(true)).toBeCloseTo(rightWithoutRail, 0);
        // A narrow Chat loses that margin, and the transcript then pads past the ticks instead of running under them.
        await setWindowWidth(900);
        await expect.poll(() => transcriptRight()).toBeLessThanOrEqual((await box(ticks.nth(1))).x);
        await page.screenshot({ path: testInfo.outputPath('rail-narrow-transcript.png') });
        await setWindowWidth(1800);

        // Resting on the rail opens one list of every message, each row beside a dash as long as its tick.
        await ticks.nth(1).hover();
        await expect(list).toHaveAttribute('data-state', 'open');
        await expect(rail.locator('[data-agent-chat-rail-ticks]')).toHaveCSS('opacity', '0');
        await expect(rows.nth(0)).toContainText('Fix the flaky build It breaks on CI');
        await expect(rows.nth(1)).toContainText('Summarize topic0');
        await expect(rows.nth(2)).toContainText('Thanks');
        // A screen reader hears a list with a position for each row, and the settled list hides the transcript behind it.
        await expect(rail.getByRole('list')).toHaveCount(1);
        await expect(rail.getByRole('listitem')).toHaveCount(3);
        await expect(list).toHaveCSS('opacity', '1');
        expect(await list.evaluate((element) => getComputedStyle(element).backgroundColor)).toMatch(
            /^rgb\(/u,
        );
        const listBox = await box(list);
        expect(listBox.x + listBox.width).toBeLessThanOrEqual(logBox.x + logBox.width);
        await page.screenshot({ path: testInfo.outputPath('rail-list.png') });

        // Clicking a row jumps there and closes the list.
        await log.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
        await rows.nth(0).click();
        await expect(list).toHaveAttribute('data-state', 'closed');
        const firstMessage = chat.getByText('Fix the flaky build').first();
        await expect.poll(async () => (await box(firstMessage)).y - logBox.y).toBeLessThan(80);
        await log.hover({ position: { x: 400, y: 40 } });
        await expect(list).toHaveAttribute('data-state', 'closed');

        // The keyboard reaches the list as one Tab stop and opens it.
        await message.focus();
        await shiftTabToRail(page, 40);
        await expect(list).toHaveAttribute('data-state', 'open');
        await page.keyboard.press('Home');
        await expect(rows.nth(0)).toBeFocused();
        await page.keyboard.press('End');
        await expect(rows.nth(2)).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(rows.nth(1)).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath('rail-list-keyboard.png') });
        await page.keyboard.press('Enter');
        await expect(rows.nth(1)).toBeFocused();
        await expect(list).toHaveAttribute('data-state', 'open');
        await page.keyboard.press('Escape');
        await expect(list).toHaveAttribute('data-state', 'closed');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
