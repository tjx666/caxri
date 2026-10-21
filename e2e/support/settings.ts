import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Presses `Cmd+,` and returns the Settings surface, scoped by `data-settings-page`. Settings is a Workbench document
 * tab (`caxri-settings://workbench`), not a modal, so there is no `role="dialog"` left to query within: this attribute
 * is the replacement scope every Settings-touching test should use in its place. Reissuing `Cmd+,` while the tab is
 * already open focuses it rather than duplicating it, so this is also the right call for "come back to Settings" after
 * navigating elsewhere in the Workbench.
 */
export async function openSettingsTab(page: Page): Promise<Locator> {
    await page.keyboard.press('Meta+,');
    const panel = page.locator('[data-settings-page]');
    await expect(panel).toBeVisible();
    return panel;
}

/**
 * Switches the Settings page to one of its sections through the single Settings navigation column. Keybindings and
 * Theme are entries of their own; the Settings list has none, so `Settings` clicks its first category, which is also
 * what a user does to get back to it.
 */
export async function openSettingsSection(
    settings: Locator,
    section: 'Settings' | 'Keybindings' | 'Theme',
): Promise<void> {
    const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
    const entry =
        section === 'Settings'
            ? navigation.getByRole('button').first()
            : navigation.getByRole('button', { name: section, exact: true });
    await entry.click();
}

/**
 * Scrolls the virtualized Settings list to a category or subcategory by clicking its table of contents entry. Rows
 * outside the viewport are not in the DOM at all (virtual rendering), so tests must reveal a section before interacting
 * with its rows.
 */
export async function revealSettingsSection(dialog: Locator, name: string): Promise<void> {
    await dialog
        .getByRole('navigation', { name: 'Settings categories' })
        .getByRole('button', { name, exact: true })
        .click();
}
