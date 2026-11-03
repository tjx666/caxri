import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Sets the `session.openAgentsInChat` preference from an open New Session or New Terminal menu through its footer "Open
 * Agents In" submenu, then closes only the submenu so `menu` stays open with its Agent rows updated. Keyboard only: a
 * hover-opened New Terminal menu closes when the pointer leaves its trigger for a submenu path it never takes.
 */
export async function setOpenAgentsIn(menu: Locator, surface: 'Chat' | 'Terminal'): Promise<void> {
    const trigger = menu.getByRole('menuitem', { name: /^Open Agents In/u });
    await expect(trigger).toBeVisible();
    // The same one-frame focus claim as `chooseTerminalFromCreateMenu`: let it land before moving focus.
    await expect
        .poll(() => menu.evaluate((popup) => popup.contains(document.activeElement)))
        .toBe(true);
    await trigger.focus();
    await trigger.press('ArrowRight');
    const choice = menu.page().getByRole('menuitemradio', { name: surface, exact: true });
    await expect(choice).toBeVisible();
    await choice.focus();
    await choice.press('Enter');
    await expect(choice).toBeChecked();
    await expect(trigger).toHaveText(new RegExp(`${surface}$`, 'u'));
    await choice.press('ArrowLeft');
    await expect(choice).toBeHidden();
}
