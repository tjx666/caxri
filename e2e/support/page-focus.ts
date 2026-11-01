import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Makes `document.hasFocus()` true without real OS window focus (a hidden or unfocused hosted window). Playwright skips
 * focus emulation for Electron, so editors that gate UI on DOM focus never see a focus event otherwise. Use it only in
 * a spec that does not depend on genuine focus.
 */
export async function forcePageFocus(page: Page): Promise<void> {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
}
