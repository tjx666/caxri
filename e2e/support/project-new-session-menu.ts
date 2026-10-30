import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * The Project heading's New Session button. Its name gains the Agent a press would start once one is remembered ("New
 * Shell Session in project"), so the pattern accepts both forms.
 */
export function projectNewSessionButton(page: Page): Locator {
    return page.getByRole('button', { name: /^New (?:.+ )?Session in /u });
}

/**
 * Opens the Project heading's New Session list from the keyboard. A press creates the remembered Agent instead of
 * opening the list, and a synthesized hover is unreliable on the CI runner, so ArrowDown (Base UI's keyboard open) is
 * the one path that always shows the list.
 */
export async function openProjectNewSessionMenu(page: Page): Promise<void> {
    const trigger = projectNewSessionButton(page);
    await trigger.focus();
    await trigger.press('ArrowDown');
    await expect(page.getByRole('menu', { name: /^New Session in /u })).toBeVisible();
}
