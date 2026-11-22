import type { Locator } from '@playwright/test';

import { expect } from './fixtures.ts';

/**
 * Returns the composer strip's Background work list, unfolding its `N more` line when the list is longer than its
 * folded rows, so every item is visible. A short list has no such line.
 */
export async function openBackgroundWork(chat: Locator): Promise<Locator> {
    const section = chat.getByRole('region', { name: 'Background work' });
    await expect(section).toBeVisible();
    const more = section.locator('[data-agent-chat-background-more]');
    if ((await more.count()) === 0) return section;
    if ((await more.getAttribute('aria-expanded')) === 'false') await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    return section;
}
