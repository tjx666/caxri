import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { createAdditionalShellSession, createShellSession, launchCaxri } from './helpers.ts';

async function expectIndicatorAligned(tablist: Locator, tab: Locator): Promise<void> {
    await expect
        .poll(async () => {
            const indicator = await tablist
                .locator('[data-slot="chrome-tab-indicator"]')
                .boundingBox();
            const content = await tab.locator('[data-slot="chrome-tab-content"]').boundingBox();
            if (!indicator || !content) return false;
            return (
                Math.abs(indicator.x - content.x) <= 1 &&
                Math.abs(indicator.width - content.width) <= 1
            );
        })
        .toBe(true);
}

async function expectPanelAssociation(page: Page, tab: Locator, visible: boolean): Promise<void> {
    const panelId = await tab.getAttribute('aria-controls');
    const tabId = await tab.getAttribute('id');
    expect(panelId).toBeTruthy();
    expect(tabId).toBeTruthy();
    if (!panelId || !tabId) throw new Error('Tab is missing its panel association');
    const panel = page.locator(`#${panelId}`);
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toHaveAttribute('aria-labelledby', tabId);
    if (visible) await expect(panel).toBeVisible();
    else await expect(panel).toBeHidden();
}

async function settleMediaChange(page: Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
}

test('Inspector and Settings share accessible moving chrome tabs', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-chrome-tabs-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const inspectorTabs = running.page.getByRole('tablist', { name: 'Inspector' });
        const filesTab = inspectorTabs.getByRole('tab', { name: 'Files', exact: true });
        const gitTab = inspectorTabs.getByRole('tab', { name: 'Git', exact: true });
        const statusTab = inspectorTabs.getByRole('tab', { name: 'Status', exact: true });
        const infoTab = inspectorTabs.getByRole('tab', { name: 'Info', exact: true });
        await expect(filesTab).toHaveAttribute('aria-selected', 'true');
        await expect(filesTab).toHaveAttribute('tabindex', '0');
        await expectPanelAssociation(running.page, filesTab, true);
        await expectPanelAssociation(running.page, gitTab, false);
        await expectPanelAssociation(running.page, statusTab, false);
        await expectPanelAssociation(running.page, infoTab, false);
        await expectIndicatorAligned(inspectorTabs, filesTab);

        await inspectorTabs.locator('[data-slot="chrome-tab-indicator"]').evaluate((indicator) => {
            const evidence = [] as string[];
            (window as unknown as { chromeTabTransitions: string[] }).chromeTabTransitions =
                evidence;
            indicator.addEventListener('transitionrun', (event) => {
                evidence.push((event as TransitionEvent).propertyName);
            });
        });
        await gitTab.click();
        await expect(gitTab).toHaveAttribute('aria-selected', 'true');
        await expectPanelAssociation(running.page, filesTab, false);
        await expectPanelAssociation(running.page, gitTab, true);
        await expect
            .poll(() =>
                running.page.evaluate(
                    () =>
                        (window as unknown as { chromeTabTransitions?: string[] })
                            .chromeTabTransitions ?? [],
                ),
            )
            .toContain('transform');
        await expectIndicatorAligned(inspectorTabs, gitTab);

        await gitTab.focus();
        await gitTab.press('ArrowRight');
        await expect(statusTab).toBeFocused();
        await expect(statusTab).toHaveAttribute('aria-selected', 'true');
        await statusTab.press('End');
        await expect(infoTab).toBeFocused();
        await infoTab.press('Home');
        await expect(filesTab).toBeFocused();
        await filesTab.press('ArrowLeft');
        await expect(infoTab).toBeFocused();

        await running.page.keyboard.press('Meta+2');
        await expect(gitTab).toHaveAttribute('aria-selected', 'true');
        const originalViewport = running.page.viewportSize() ?? { width: 1280, height: 720 };
        const wideIndicatorWidth = await inspectorTabs
            .locator('[data-slot="chrome-tab-indicator"]')
            .evaluate((element) => element.getBoundingClientRect().width);
        await running.page.setViewportSize({ width: 1000, height: originalViewport.height });
        await expect(gitTab.locator('[data-slot="chrome-tab-label"]')).toBeHidden();
        await expectIndicatorAligned(inspectorTabs, gitTab);
        await expect
            .poll(() =>
                inspectorTabs
                    .locator('[data-slot="chrome-tab-indicator"]')
                    .evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeLessThan(wideIndicatorWidth);
        await running.page.setViewportSize(originalViewport);

        const firstSession = running.page.locator('.session-card').first();
        await createAdditionalShellSession(running.page);
        await expect(filesTab).toHaveAttribute('aria-selected', 'true');
        await expectIndicatorAligned(inspectorTabs, filesTab);
        await firstSession.click();
        await expect(gitTab).toHaveAttribute('aria-selected', 'true');
        await expectIndicatorAligned(inspectorTabs, gitTab);

        await running.page.keyboard.press('Meta+,');
        const dialog = running.page.getByRole('dialog');
        const settingsTabs = dialog.getByRole('tablist', { name: 'Settings sections' });
        const settingsTab = settingsTabs.getByRole('tab', { name: 'Settings', exact: true });
        const keybindingsTab = settingsTabs.getByRole('tab', {
            name: 'Keybindings',
            exact: true,
        });
        const themeTab = settingsTabs.getByRole('tab', { name: 'Theme', exact: true });
        await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
        await expectPanelAssociation(running.page, settingsTab, true);
        await expectPanelAssociation(running.page, keybindingsTab, false);
        await expectPanelAssociation(running.page, themeTab, false);
        await expectIndicatorAligned(settingsTabs, settingsTab);
        const cleanWidth = await settingsTabs
            .locator('[data-slot="chrome-tab-indicator"]')
            .evaluate((element) => element.getBoundingClientRect().width);
        await dialog.getByLabel('Terminal font size').fill('14');
        await expect(settingsTab.locator('[data-dirty="true"]')).toBeVisible();
        await expectIndicatorAligned(settingsTabs, settingsTab);
        await expect
            .poll(() =>
                settingsTabs
                    .locator('[data-slot="chrome-tab-indicator"]')
                    .evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeGreaterThan(cleanWidth);

        await settingsTab.focus();
        await settingsTab.press('ArrowRight');
        await expect(keybindingsTab).toBeFocused();
        await expect(keybindingsTab).toHaveAttribute('aria-selected', 'true');
        await running.page.emulateMedia({ reducedMotion: 'reduce' });
        await settleMediaChange(running.page);
        await themeTab.click();
        await expect(themeTab).toHaveAttribute('aria-selected', 'true');
        await expect(settingsTabs.locator('[data-slot="chrome-tab-indicator"]')).toHaveCSS(
            'transition-duration',
            '0s',
        );
        await expectIndicatorAligned(settingsTabs, themeTab);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
