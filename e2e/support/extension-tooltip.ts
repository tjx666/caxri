import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

async function waitForTooltipAnimation(tooltip: Locator): Promise<void> {
    await tooltip.evaluate(async (element) => {
        await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
    });
}

export async function verifyTreeTooltipPositioning(
    page: Page,
    tree: Locator,
    fixtureTab: Locator,
): Promise<void> {
    const tooltipRow = tree.getByRole('treeitem', { name: 'Tooltip row', exact: true });
    const rowBounds = await tooltipRow.boundingBox();
    if (!rowBounds) throw new Error('Tooltip row bounds are unavailable');
    const tooltip = page
        .locator('.tooltip-popup:visible')
        .filter({ hasText: 'Full fixture tooltip' });
    const pointerY = rowBounds.y + rowBounds.height / 2;
    const tooltipBoundsAt = async (pointerX: number) => {
        await page.mouse.move(0, 0);
        await expect(tooltip).toHaveCount(0);
        await page.mouse.move(pointerX, pointerY);
        await expect(tooltip).toBeVisible();
        await waitForTooltipAnimation(tooltip);
        const bounds = await tooltip.boundingBox();
        if (!bounds) throw new Error('Cursor-anchored tooltip bounds are unavailable');
        return bounds;
    };

    const leftPointerX = rowBounds.x + 12;
    const leftBounds = await tooltipBoundsAt(leftPointerX);
    expect(leftBounds.x).toBeGreaterThanOrEqual(leftPointerX + 4);
    expect(leftBounds.x).toBeLessThanOrEqual(leftPointerX + 16);

    const centerPointerX = rowBounds.x + rowBounds.width / 2;
    await page.mouse.move(centerPointerX, pointerY);
    await page.waitForTimeout(150);
    const stableBounds = await tooltip.boundingBox();
    expect(stableBounds).toMatchObject({ x: leftBounds.x, y: leftBounds.y });

    const centerBounds = await tooltipBoundsAt(centerPointerX);
    expect(centerBounds.x).toBeGreaterThanOrEqual(centerPointerX + 4);
    expect(centerBounds.x).toBeLessThanOrEqual(centerPointerX + 16);
    expect(centerBounds.x).toBeGreaterThan(leftBounds.x + rowBounds.width / 3);

    const rightPointerX = rowBounds.x + rowBounds.width - 4;
    const rightBounds = await tooltipBoundsAt(rightPointerX);
    const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(rightBounds.x + rightBounds.width).toBeLessThanOrEqual(viewportWidth - 8);
    expect(rightBounds.x).toBeLessThan(rightPointerX);

    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
    await tree.getByRole('treeitem', { name: 'Empty children', exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(tooltipRow).toBeFocused();
    await expect(tooltip).toBeVisible();
    await waitForTooltipAnimation(tooltip);
    const focusBounds = await tooltip.boundingBox();
    if (!focusBounds) throw new Error('Focus-anchored tooltip bounds are unavailable');
    expect(focusBounds.x + focusBounds.width / 2).toBeCloseTo(rowBounds.x + rowBounds.width / 2, 0);

    await tooltipRow.evaluate((element) => (element as HTMLElement).blur());
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
    const fixtureTabBounds = await fixtureTab.boundingBox();
    if (!fixtureTabBounds) throw new Error('Fixture tab bounds are unavailable');
    await page.mouse.move(fixtureTabBounds.x + 2, fixtureTabBounds.y + fixtureTabBounds.height / 2);
    const fixtureTabTooltip = page
        .locator('.tooltip-popup:visible')
        .filter({ hasText: 'Extension Fixture' });
    await expect(fixtureTabTooltip).toBeVisible();
    await waitForTooltipAnimation(fixtureTabTooltip);
    const fixtureTabTooltipBounds = await fixtureTabTooltip.boundingBox();
    if (!fixtureTabTooltipBounds) throw new Error('Fixture tab tooltip bounds are unavailable');
    expect(fixtureTabTooltipBounds.x + fixtureTabTooltipBounds.width / 2).toBeCloseTo(
        fixtureTabBounds.x + fixtureTabBounds.width / 2,
        0,
    );
    await page.mouse.move(0, 0);
    await expect(fixtureTabTooltip).toHaveCount(0);
}

export async function verifyBottomEdgeTreeTooltip(page: Page, last: Locator): Promise<void> {
    const lastBounds = await last.boundingBox();
    if (!lastBounds) throw new Error('Last virtual row bounds are unavailable');
    await last.evaluate((element) => (element as HTMLElement).blur());
    await page.mouse.move(0, 0);
    const pointerY = lastBounds.y + lastBounds.height / 2;
    await page.mouse.move(lastBounds.x + lastBounds.width / 2, pointerY);
    const tooltip = page.locator('.tooltip-popup:visible').filter({ hasText: 'Virtual row 399' });
    await expect(tooltip).toBeVisible();
    await waitForTooltipAnimation(tooltip);
    const tooltipBounds = await tooltip.boundingBox();
    if (!tooltipBounds) throw new Error('Last row tooltip bounds are unavailable');
    const viewportHeight = await page.evaluate(() => document.documentElement.clientHeight);
    expect(tooltipBounds.y).toBeLessThan(pointerY);
    expect(tooltipBounds.y + tooltipBounds.height).toBeLessThanOrEqual(viewportHeight - 8);
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
}
