import type { Page } from '@playwright/test';

/**
 * How long `hold-press` waits before its screenshot. A surface that opens while keys are held can reveal after a delay
 * (the Session MRU switcher waits 120ms), and a fake-provider dev window is hidden, so its timers run throttled.
 */
const HOLD_SCREENSHOT_DELAY_MS = 1_000;

/**
 * Splits a Playwright chord (`Control+Alt+Tab`) into the keys `hold-press` keeps down and the one it presses. A lone
 * `+` key (`Control++`) stays the pressed key.
 */
export function splitHeldChord(chord: string): { modifiers: string[]; key: string } {
    const parts = chord.endsWith('++') ? [...chord.slice(0, -2).split('+'), '+'] : chord.split('+');
    const key = parts.pop() ?? '';
    return { modifiers: parts.filter(Boolean), key };
}

/**
 * Keeps the modifiers down across every press, which a single `keyboard.press('Control+Alt+Tab')` cannot: it releases
 * them after one press, so a switcher that stays open while they are held closes before the next Tab.
 */
export async function holdPress(page: Page, chord: string, times: number, screenshot?: string) {
    const { modifiers, key } = splitHeldChord(chord);
    // A CDP connection does not focus the window, and the shortcut only reaches a focused document.
    await page.bringToFront();
    for (const modifier of modifiers) {
        // eslint-disable-next-line no-await-in-loop -- keys go down in order, as a hand presses them.
        await page.keyboard.down(modifier);
    }
    try {
        for (let press = 0; press < times; press += 1) {
            // eslint-disable-next-line no-await-in-loop
            await page.keyboard.press(key);
        }
        if (screenshot) {
            await page.waitForTimeout(HOLD_SCREENSHOT_DELAY_MS);
            await page.screenshot({ path: screenshot });
        }
    } finally {
        for (const modifier of modifiers.toReversed()) {
            // eslint-disable-next-line no-await-in-loop
            await page.keyboard.up(modifier);
        }
    }
}
