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

const PREVIEW = '[data-agent-chat-rail-preview]';

/**
 * Three messages whose cards are easy to tell apart: a multi-line one, one long line, and a path reference. Each avoids
 * the fake Codex's scenario words (`fail`, `slow`, `ask`, ...), so every one gets the default quoted reply.
 */
const MESSAGES = [
    'Fix the flaky build\nIt breaks on CI about once in ten runs.\nStart with the cache step.',
    `Summarize ${Array.from({ length: 40 }, (_, index) => `topic${index}`).join(' ')}`,
    'Open /work/project/src/very/deeply/nested/module/with/a/long/name/index.ts please',
];

async function box(locator: Locator) {
    const bounds = await locator.boundingBox();
    if (!bounds) throw new Error('Expected a visible element');
    return bounds;
}

/**
 * Where the transcript's text starts: its centered column's left edge plus the column's left padding.
 */
function contentLeft(log: Locator): Promise<number> {
    return log.evaluate((element) => {
        const column = element.firstElementChild;
        if (!(column instanceof HTMLElement)) throw new Error('Expected a transcript column');
        return (
            column.getBoundingClientRect().left +
            Number(getComputedStyle(column).paddingLeft.replace('px', ''))
        );
    });
}

/**
 * Asserts the one open card sits right of `tick` and inside the window.
 */
async function expectCardBeside(page: Page, card: Locator, tick: Locator) {
    const cardBox = await box(card);
    const tickBox = await box(tick);
    const viewport =
        page.viewportSize() ??
        (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    expect(cardBox.x).toBeGreaterThanOrEqual(tickBox.x + tickBox.width);
    expect(cardBox.y).toBeGreaterThanOrEqual(0);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width);
    return cardBox;
}

/**
 * Presses Shift+Tab until a rail tick has focus, at most `remaining` times, so the rail is reached the way a keyboard
 * user reaches it rather than by focusing a tick from script.
 */
async function shiftTabToRail(page: Page, remaining: number): Promise<void> {
    const isTick = await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-agent-chat-rail-tick'),
    );
    if (isTick || remaining === 0) return;
    await page.keyboard.press('Shift+Tab');
    await shiftTabToRail(page, remaining - 1);
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('The message rail previews each tick in one fixed-size card for pointer and keyboard', async ({}, testInfo) => {
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
        const transcriptLeft = () => contentLeft(chat.getByRole('log'));
        const leftWithoutRail = await transcriptLeft();
        await send(MESSAGES[1], /You said: Summarize topic0/u);
        await send(MESSAGES[2], /You said: Open/u);
        const rail = chat.getByRole('navigation', { name: 'Messages' });
        const ticks = rail.getByRole('button');
        await expect(ticks).toHaveCount(3);

        // A wide Chat's centered column already clears the rail, so its appearing never moves the transcript.
        expect(await transcriptLeft()).toBeCloseTo(leftWithoutRail, 0);
        // A narrow Chat loses that margin, and the transcript then pads past the ticks instead of running under them.
        await setWindowWidth(900);
        await expect
            .poll(transcriptLeft)
            .toBeGreaterThanOrEqual((await box(rail)).x + (await box(rail)).width);
        await page.screenshot({ path: testInfo.outputPath('rail-narrow-transcript.png') });
        await setWindowWidth(1800);
        const ids = await ticks.evaluateAll((elements) =>
            elements.map((element) => element.dataset.agentChatRailTick ?? ''),
        );
        const cards = page.locator(PREVIEW);
        const card = (index: number) =>
            page.locator(`${PREVIEW}[data-agent-chat-rail-preview="${ids[index]}"]`);

        // Hover opens the card beside the tick, with the first line as its title and the rest below it.
        await ticks.nth(0).hover();
        await expect(card(0)).toBeVisible();
        await expect(card(0)).toContainText('Fix the flaky build');
        await expect(card(0)).toContainText('Start with the cache step.');
        await expect(card(0)).toContainText('You');
        const first = await expectCardBeside(page, card(0), ticks.nth(0));
        await page.screenshot({ path: testInfo.outputPath('rail-card-multiline.png') });

        // An open card moves to the next tick at once: one card, the current tick's, the same size.
        await ticks.nth(1).hover();
        await expect(cards).toHaveCount(1);
        await expect(card(1)).toBeVisible();
        await expect(card(1)).toContainText('topic0');
        const second = await expectCardBeside(page, card(1), ticks.nth(1));
        expect(second.width).toBeCloseTo(first.width, 0);
        expect(second.height).toBeCloseTo(first.height, 0);
        await ticks.nth(2).hover();
        await expect(cards).toHaveCount(1);
        await expect(card(2)).toContainText('index.ts');
        const third = await expectCardBeside(page, card(2), ticks.nth(2));
        expect(third.height).toBeCloseTo(first.height, 0);
        await page.screenshot({ path: testInfo.outputPath('rail-card-path.png') });

        // A fast sweep back up never leaves a passed tick's text behind.
        await ticks.nth(1).hover();
        await ticks.nth(0).hover();
        await expect(cards).toHaveCount(1);
        await expect(card(0)).toBeVisible();

        // Leaving the rail closes the card.
        await chat.getByRole('log').hover({ position: { x: 400, y: 40 } });
        await expect(cards).toHaveCount(0);

        // The keyboard reaches the rail as one Tab stop and sees the same cards.
        await message.focus();
        await shiftTabToRail(page, 40);
        await expect(ticks.nth(2)).toBeFocused();
        await expect(card(2)).toBeVisible();
        await page.keyboard.press('ArrowUp');
        await expect(ticks.nth(1)).toBeFocused();
        await expect(card(1)).toBeVisible();
        await expect(cards).toHaveCount(1);
        await page.keyboard.press('Home');
        await expect(card(0)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('rail-card-keyboard.png') });
        await page.keyboard.press('End');
        await expect(card(2)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(cards).toHaveCount(0);
        await page.keyboard.press('Home');
        await page.keyboard.press('Enter');
        await expect(ticks.nth(0)).toBeFocused();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
