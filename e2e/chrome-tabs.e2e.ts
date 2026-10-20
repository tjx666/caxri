import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    openSettingsTab,
    pageRequest,
    revealSettingsSection,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';
import { stableWidth } from './support/motion-settle.ts';

/**
 * Mirrors `INDICATOR_INSET` in `components/chrome-tabs.tsx`. Duplicated rather than imported so this spec stays a plain
 * Playwright module instead of pulling React into the test runner.
 */
const INDICATOR_INSET = 8;

/**
 * Mirrors the `indicatorMaxWidth` the SecondarySidebar passes in `features/view-containers/view-container-surface.tsx`.
 */
const INDICATOR_MAX_WIDTH = 48;

/**
 * The indicator is derived from the tab slot, not the label inside it: inset from both slot edges and centred in it.
 */
async function expectIndicatorAligned(tablist: Locator, tab: Locator): Promise<void> {
    await expect
        .poll(async () => {
            const indicator = await tablist
                .locator('[data-slot="chrome-tab-indicator"]')
                .boundingBox();
            const slot = await tab.boundingBox();
            if (!indicator || !slot) return false;
            const isCentered =
                Math.abs(indicator.x + indicator.width / 2 - (slot.x + slot.width / 2)) <= 1;
            return (
                isCentered &&
                indicator.width > 0 &&
                indicator.width <= slot.width - INDICATOR_INSET * 2 + 1
            );
        })
        .toBe(true);
}

type IndicatorTransitionWindow = typeof globalThis & { chromeTabTransitions?: string[] };

/**
 * The `transitionrun` properties the SecondarySidebar indicator recorded since the last clear.
 */
function indicatorTransitions(page: Page): Promise<string[]> {
    return page.evaluate(
        () => (globalThis as IndicatorTransitionWindow).chromeTabTransitions?.slice() ?? [],
    );
}

async function clearIndicatorTransitions(page: Page): Promise<void> {
    await page.evaluate(() => {
        (globalThis as IndicatorTransitionWindow).chromeTabTransitions?.splice(0);
    });
}

/**
 * Resolves after `count` presented frames, long enough for a started transition to report `transitionrun`.
 */
async function afterFrames(page: Page, count: number): Promise<void> {
    await page.evaluate(async (frames) => {
        for (let index = 0; index < frames; index += 1)
            // eslint-disable-next-line no-await-in-loop -- one frame after another is the point
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }, count);
}

async function expectPanelAssociation(page: Page, tab: Locator, isVisible: boolean): Promise<void> {
    const panelId = await tab.getAttribute('aria-controls');
    const tabId = await tab.getAttribute('id');
    expect(panelId).toBeTruthy();
    expect(tabId).toBeTruthy();
    if (!panelId || !tabId) throw new Error('Tab is missing its panel association');
    const panel = page.locator(`[id=${JSON.stringify(panelId)}]`);
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toHaveAttribute('aria-labelledby', tabId);
    if (isVisible) await expect(panel).toBeVisible();
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

test('SecondarySidebar and Settings share accessible moving chrome tabs', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-chrome-tabs-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const secondarySidebarTabs = running.page.getByRole('tablist', {
            name: 'Secondary Side Bar',
        });
        const filesTab = secondarySidebarTabs.getByRole('tab', { name: 'Files', exact: true });
        const gitTab = secondarySidebarTabs.getByRole('tab', {
            name: 'Git',
            exact: true,
        });
        const statusTab = secondarySidebarTabs.getByRole('tab', { name: 'Status', exact: true });
        const fixtureTab = secondarySidebarTabs.getByRole('tab', {
            name: 'Extension Fixture',
            exact: true,
        });
        // Info and Logs are Panel views, not SecondarySidebar tabs; the SecondarySidebar rail is the
        // narrow tree/list surface only.
        await expect(secondarySidebarTabs.getByRole('tab')).toHaveCount(4);
        await expect(filesTab).toHaveAttribute('aria-selected', 'true');
        await expect(filesTab).toHaveAttribute('tabindex', '0');
        await expectPanelAssociation(running.page, filesTab, true);
        await expectPanelAssociation(running.page, gitTab, false);
        await expectPanelAssociation(running.page, statusTab, false);
        await expectPanelAssociation(running.page, fixtureTab, false);
        await expectIndicatorAligned(secondarySidebarTabs, filesTab);
        /**
         * The rail divides evenly across the whole SecondarySidebar. A per-tab width cap once left-aligned the strip
         * and left the rest of the rail empty.
         */
        const railFill = await secondarySidebarTabs.evaluate((list) => {
            const listWidth = list.getBoundingClientRect().width;
            const tabWidths = [...list.querySelectorAll('[role="tab"]')].map(
                (tab) => tab.getBoundingClientRect().width,
            );
            return {
                fill: listWidth / list.parentElement!.getBoundingClientRect().width,
                spread: Math.max(...tabWidths) - Math.min(...tabWidths),
            };
        });
        expect(railFill.fill).toBeGreaterThan(0.99);
        expect(railFill.spread).toBeLessThan(1);

        await secondarySidebarTabs
            .locator('[data-slot="chrome-tab-indicator"]')
            .evaluate((indicator) => {
                const evidence = [] as string[];
                Object.defineProperty(globalThis, 'chromeTabTransitions', {
                    configurable: true,
                    value: evidence,
                });
                indicator.addEventListener('transitionrun', (event) => {
                    evidence.push((event as TransitionEvent).propertyName);
                });
            });
        await gitTab.click();
        await expect(gitTab).toHaveAttribute('aria-selected', 'true');
        await expectPanelAssociation(running.page, filesTab, false);
        await expectPanelAssociation(running.page, gitTab, true);
        await expect.poll(() => indicatorTransitions(running.page)).toContain('transform');
        await expectIndicatorAligned(secondarySidebarTabs, gitTab);

        await gitTab.focus();
        await gitTab.press('ArrowRight');
        await expect(fixtureTab).toBeFocused();
        await expect(fixtureTab).toHaveAttribute('aria-selected', 'true');
        await fixtureTab.press('ArrowRight');
        await expect(statusTab).toBeFocused();
        await statusTab.press('Home');
        await expect(filesTab).toBeFocused();
        await filesTab.press('End');
        await expect(statusTab).toBeFocused();
        await statusTab.press('ArrowRight');
        await expect(filesTab).toBeFocused();
        await filesTab.press('ArrowLeft');
        await expect(statusTab).toBeFocused();

        // A shortcut changes the tab within the same Session, so the mark still glides to it.
        await clearIndicatorTransitions(running.page);
        await running.page.keyboard.press('Meta+Alt+2');
        await expect(gitTab).toHaveAttribute('aria-selected', 'true');
        await expect.poll(() => indicatorTransitions(running.page)).toContain('transform');
        /**
         * The rail divides evenly and each mark is capped, so the indicator is the same size on every tab and stays put
         * when a responsive tab drops its label. A label-width indicator used to jump between an icon-plus-word and a
         * bare icon, and on a wide rail a slot-width one would stretch into a filled segment.
         */
        const indicatorWidth = async (): Promise<number> =>
            secondarySidebarTabs
                .locator('[data-slot="chrome-tab-indicator"]')
                .evaluate((element) => element.getBoundingClientRect().width);
        const cappedWidth = await stableWidth(
            secondarySidebarTabs.locator('[data-slot="chrome-tab-indicator"]'),
        );
        expect(cappedWidth).toBeGreaterThan(0);
        expect(cappedWidth).toBeLessThanOrEqual(INDICATOR_MAX_WIDTH);
        await filesTab.click();
        await expectIndicatorAligned(secondarySidebarTabs, filesTab);
        await expect.poll(indicatorWidth).toBe(cappedWidth);
        await gitTab.click();

        /**
         * SecondarySidebar tabs are icon-only: the title lives in the tab's accessible name and tooltip, never in an
         * inline label, so resizing the window must not change the tab content or the capped indicator.
         */
        const originalViewport = running.page.viewportSize() ?? { width: 1280, height: 720 };
        await expect(gitTab.locator('[data-slot="chrome-tab-label"]')).toHaveCount(0);
        await running.page.setViewportSize({ width: 1000, height: originalViewport.height });
        await expect(gitTab.locator('[data-slot="chrome-tab-label"]')).toHaveCount(0);
        await expectIndicatorAligned(secondarySidebarTabs, gitTab);
        await expect.poll(indicatorWidth).toBe(cappedWidth);
        await running.page.setViewportSize(originalViewport);

        /**
         * Each Session remembers its own container, so a switch changes the selected tab without the user picking one.
         * The mark lands on it at once: sweeping across the rail on every Session switch read as the selection
         * changing.
         */
        const firstSessionId = await selectedSessionId(running.page);
        await clearIndicatorTransitions(running.page);
        await createAdditionalShellSession(running.page);
        await expect(filesTab).toHaveAttribute('aria-selected', 'true');
        await expectIndicatorAligned(secondarySidebarTabs, filesTab);
        await sessionCard(running.page, firstSessionId).click();
        await expect(gitTab).toHaveAttribute('aria-selected', 'true');
        await expectIndicatorAligned(secondarySidebarTabs, gitTab);
        await afterFrames(running.page, 2);
        expect(await indicatorTransitions(running.page)).not.toContain('transform');

        // The Panel hosts a second, independently collapsible ChromeTabs strip. It must
        // carry the same roles, panel wiring, and moving indicator as the SecondarySidebar's, and its
        // selection must stay independent of the SecondarySidebar's.
        const bottomTabs = running.page.getByRole('tablist', { name: 'Panel' });
        await expect(bottomTabs).toHaveCount(0);
        await running.page.keyboard.press('Meta+j');
        const logsTab = bottomTabs.getByRole('tab', { name: 'Logs', exact: true });
        const infoTab = bottomTabs.getByRole('tab', { name: 'Info', exact: true });
        await expect(logsTab).toHaveAttribute('aria-selected', 'true');
        await expectPanelAssociation(running.page, logsTab, true);
        await expectPanelAssociation(running.page, infoTab, false);
        await expectIndicatorAligned(bottomTabs, logsTab);
        await infoTab.click();
        await expect(infoTab).toHaveAttribute('aria-selected', 'true');
        await expectPanelAssociation(running.page, logsTab, false);
        await expectIndicatorAligned(bottomTabs, infoTab);
        await expect(gitTab).toHaveAttribute('aria-selected', 'true');
        await infoTab.press('Meta+j');
        await expect(bottomTabs).toHaveCount(0);

        // Named `settingsPanel`, not `settingsTab`: the latter name is already the "Settings" entry
        // inside `settingsTabs` below (the Settings/Keybindings/Theme sub-tabs), a different thing
        // from the outer Workbench tab this opens.
        const settingsPanel = await openSettingsTab(running.page);
        const settingsTabs = settingsPanel.getByRole('tablist', { name: 'Settings sections' });
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
         * Settings now apply immediately (`f4dfe59`): a field commits straight to disk as it changes, with no
         * draft/Apply step and no per-tab dirty badge for the chrome tab to grow around; `[data-dirty="true"]` no
         * longer exists anywhere in the DOM. The regression this sub-case protects is the new contract instead: editing
         * a field must persist without an explicit Apply affordance, and the moving indicator must keep tracking the
         * (visually unchanged) tab through that write rather than drifting or losing alignment.
         */
        await revealSettingsSection(settingsPanel, 'Terminal');
        await settingsPanel.getByRole('spinbutton', { name: 'Terminal Font size' }).fill('14');
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
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
