import type { Page } from '@playwright/test';

export const IDLE_POLL_MS = 1_000;
/**
 * Consecutive unchanged polls that count as idle: a streaming reply can pause for a second between chunks.
 */
const IDLE_STABLE_POLLS = 3;

/**
 * The window text `idle` compares between polls, with every digit run masked. A running background task's elapsed time
 * and the status row's figures tick every second, so comparing raw text never settled while work ran in the background;
 * a streaming reply still changes its words.
 */
export function idleComparableText(text: string): string {
    return text.replaceAll(/\d+/g, '#');
}

/**
 * Waits until the window's text stops changing for `IDLE_STABLE_POLLS` polls, failing after `seconds`.
 */
export async function waitForIdle(page: Page, seconds: number): Promise<void> {
    const deadline = Date.now() + seconds * 1_000;
    let previous = '';
    let stable = 0;
    while (stable < IDLE_STABLE_POLLS) {
        if (Date.now() > deadline) throw new Error(`Window text still changing after ${seconds}s`);
        // Each poll compares against the previous one, so the waits are sequential by design.
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(IDLE_POLL_MS);
        // eslint-disable-next-line no-await-in-loop
        const text = idleComparableText((await page.locator('body').textContent()) ?? '');
        stable = text === previous ? stable + 1 : 0;
        previous = text;
    }
}
