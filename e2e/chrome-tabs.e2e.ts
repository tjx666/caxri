import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from './support/fixtures.ts';

import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';

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

/**
 * The Settings dialog opens with a `zoom-in-95` keyframe, so a width measured while it plays is
 * scaled down by up to 5%. `expectIndicatorAligned` cannot catch that on its own: the indicator and
 * the tab content it tracks are scaled together and stay aligned throughout the animation. Poll for
 * two consecutive equal readings before pinning an absolute pixel baseline.
 */
async function stableWidth(locator: Locator): Promise<number> {
    let previous = Number.NaN;
    await expect
        .poll(async () => {
            const width = await locator.evaluate(
                (element) =>
                    new Promise<number>((resolve) =>
                        requestAnimationFrame(() => resolve(element.getBoundingClientRect().width)),
                    ),
            );
            const stable = width === previous;
            previous = width;
            return stable;
        })
        .toBe(true);
    return previous;
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
        await running.page.setViewportSize({ width: 1200, height: originalViewport.height });
        await expect(gitTab.locator('[data-slot="chrome-tab-label"]')).toBeVisible();
        await expectIndicatorAligned(inspectorTabs, gitTab);
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
        const cleanWidth = await stableWidth(
            settingsTabs.locator('[data-slot="chrome-tab-indicator"]'),
        );
        /**
         * Settings now apply immediately (`f4dfe59`): a field commits straight to disk as it
         * changes, with no draft/Apply step and no per-tab dirty badge for the chrome tab to grow
         * around — `[data-dirty="true"]` no longer exists anywhere in the DOM. The regression this
         * sub-case protects is the new contract instead: editing a field must persist without an
         * explicit Apply affordance, and the moving indicator must keep tracking the (visually
         * unchanged) tab through that write rather than drifting or losing alignment.
         */
        await dialog.getByLabel('Terminal font size').fill('14');
        await expect
            .poll(async () => {
                const settings = await pageRequest<{ value: { 'terminal.fontSize': number } }>(
                    running.page,
                    'settings.get',
                );
                return settings.value['terminal.fontSize'];
            })
            .toBe(14);
        await expectIndicatorAligned(settingsTabs, settingsTab);
        // Sub-pixel tolerance rather than exact float equality: the point is that the tab did not
        // grow by a dirty badge, not that layout reproduces bit-for-bit across a re-render.
        expect(
            await stableWidth(settingsTabs.locator('[data-slot="chrome-tab-indicator"]')),
        ).toBeCloseTo(cleanWidth, 0);

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
