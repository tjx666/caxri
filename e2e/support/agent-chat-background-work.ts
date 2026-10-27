import type { Locator } from '@playwright/test';

import { expect } from './fixtures.ts';

/**
 * Returns the composer strip's Background work section, unfolding it when the user folded it, so its tasks are visible.
 * A single running task has no fold header: its row is the whole section.
 */
export async function openBackgroundWork(chat: Locator): Promise<Locator> {
    const section = chat.getByRole('region', { name: 'Background work' });
    await expect(section).toBeVisible();
    const toggle = section.locator('[data-agent-chat-strip-fold]');
    if ((await toggle.count()) === 0) return section;
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    return section;
}
