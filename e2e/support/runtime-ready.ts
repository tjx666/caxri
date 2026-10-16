import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * The status bar only shows a state chip while degraded. Its data attribute publishes readiness in every visual state.
 */
export function runtimeStatus(page: Page) {
    return page.locator('.statusbar');
}

export async function waitForRuntimeReady(page: Page): Promise<void> {
    await expect(runtimeStatus(page)).toHaveAttribute('data-runtime-status', 'ready');
}
