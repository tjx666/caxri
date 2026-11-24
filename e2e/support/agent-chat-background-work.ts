import type { Locator } from '@playwright/test';

import { expect } from './fixtures.ts';

/**
 * Returns the composer strip's Background work list with its rows in view, unfolding the section when its header folded
 * it.
 */
export async function openBackgroundWork(chat: Locator): Promise<Locator> {
    const section = chat.getByRole('region', { name: 'Background work' });
    await expect(section).toBeVisible();
    const fold = section.locator('[data-agent-chat-strip-fold]');
    if ((await fold.getAttribute('aria-expanded')) === 'false') await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    return section;
}
