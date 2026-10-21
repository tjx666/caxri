import type { Locator, Page } from '@playwright/test';

import { expect } from './fixtures.ts';

/**
 * The status row's controls that open its Background work section: the badge while the Chat is busy, or the lead naming
 * running or failed tasks after the turn.
 */
const BACKGROUND_WORK_TRIGGER =
    /^Background work: |^Still running in the background: |background tasks? (?:running|failed)\. Show details$/u;

/**
 * Opens the composer status row's Background work popover, unless it is already open, and returns its section. The
 * popover renders in the window's portal, outside the Chat, so the section is found on `page`.
 */
export async function openBackgroundWork(page: Page, chat: Locator): Promise<Locator> {
    const section = page.getByRole('region', { name: 'Background work' });
    if (await section.isVisible()) return section;
    await chat
        .locator('[data-agent-chat-status-row]')
        .getByRole('button', { name: BACKGROUND_WORK_TRIGGER })
        .first()
        .click();
    await expect(section).toBeVisible();
    return section;
}
