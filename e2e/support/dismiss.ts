import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Asserts the dialog headed `heading` is open, then presses Escape until it is gone. Escape is layered: an open tooltip
 * (for example on the focused tile of a dialog while no Agent is installed) consumes the first press and the dialog
 * handles the next, so a single press cannot prove dismissal.
 */
export async function dismissDialogWithEscape(page: Page, heading: string): Promise<void> {
    const title = page.getByRole('heading', { name: heading });
    await expect(title).toBeVisible();
    await expect(async () => {
        await page.keyboard.press('Escape');
        await expect(title).toBeHidden({ timeout: 1000 });
    }).toPass();
}
