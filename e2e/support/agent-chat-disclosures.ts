import type { Locator } from '@playwright/test';

import { expect } from './fixtures.ts';

/**
 * Waits until every expanded disclosure of one kind has finished its height transition, so a screenshot shows the
 * opened content rather than the first frame of the animation.
 */
export async function expectDisclosuresSettled(scope: Locator, kind: string): Promise<void> {
    await expect
        .poll(() =>
            scope
                .locator(`[data-disclosure="${kind}"][data-expanded="true"]`)
                .evaluateAll((nodes) =>
                    nodes.every(
                        (node) =>
                            Math.abs(node.getBoundingClientRect().height - node.scrollHeight) < 1,
                    ),
                ),
        )
        .toBe(true);
}
