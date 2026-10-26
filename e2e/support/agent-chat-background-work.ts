import type { Locator } from '@playwright/test';

import { expect } from './fixtures.ts';

/**
 * Returns the composer strip's Background work section, unfolding it when the user folded it, so its tasks are visible.
 */
export async function openBackgroundWork(chat: Locator): Promise<Locator> {
    const section = chat.getByRole('region', { name: 'Background work' });
    await expect(section).toBeVisible();
    const toggle = section.locator('button[aria-expanded]').first();
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    return section;
}
