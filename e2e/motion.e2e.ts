import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import type { Locator, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    openSettingsTab,
    pressNewTerminal,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';
import { pollUntil } from './support/polling.ts';

/**
 * Mirrors `lib/motion.ts`'s `motionDurationMs` parsing so a `--motion-*` token and a computed CSS duration (which the
 * browser normalizes to a different unit/precision, e.g. `130ms` vs `0.13s`) compare as numbers instead of as strings.
 * Every expected timing in this spec is derived from a token through this helper — never a hardcoded millisecond
 * literal, per the DESIGN.md "Motion" contract this suite verifies.
 */
function parseDurationMs(raw: string): number | null {
    const match = /^(?<value>[\d.]+)(?<unit>m?s)$/.exec(raw.trim());
    if (!match?.groups) return null;
    const value = Number(match.groups.value);
    return match.groups.unit === 's' ? value * 1000 : value;
}

function requireDurationMs(raw: string): number {
    const duration = parseDurationMs(raw);
    if (duration === null) throw new Error(`Unparsable CSS duration: "${raw}"`);
    return duration;
}

async function motionTokenMs(page: Page, token: string): Promise<number> {
    const raw = await page.evaluate(
        (name) => getComputedStyle(document.documentElement).getPropertyValue(name),
        token,
    );
    return requireDurationMs(raw);
}

async function transitionDurationMs(locator: Locator): Promise<number> {
    const raw = await locator.evaluate((element) => getComputedStyle(element).transitionDuration);
    return requireDurationMs(raw);
}

async function animationDurationMs(locator: Locator): Promise<number> {
    const raw = await locator.evaluate((element) => getComputedStyle(element).animationDuration);
    return requireDurationMs(raw);
}

async function animationNameOf(locator: Locator): Promise<string> {
    return locator.evaluate((element) => getComputedStyle(element).animationName);
}

/**
 * Captures the tab's transient accessibility-safe exit state in the browser process. A Playwright positional locator
 * such as `.last()` can retarget the surviving sibling after the exiting tab is removed, and a loaded runner can miss
 * the short exit window before the next protocol round trip.
 */
async function startWorkTabExitProbe(tab: Locator): Promise<void> {
    await tab.evaluate((element) => {
        const probe = { observed: false };
        const observer = new MutationObserver(() => {
            if (element.getAttribute('aria-hidden') !== 'true' || !element.hasAttribute('inert'))
                return;
            probe.observed = true;
            observer.disconnect();
        });
        observer.observe(element, {
            attributeFilter: ['aria-hidden', 'inert'],
            attributes: true,
        });
        Object.defineProperty(globalThis, 'workTabExitProbe', {
            configurable: true,
            value: { observer, probe },
        });
    });
}

async function wasWorkTabExitObserved(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const state = (
            globalThis as unknown as {
                workTabExitProbe?: {
                    probe: { observed: boolean };
                };
            }
        ).workTabExitProbe;
        if (!state) throw new Error('Work tab exit probe was not started');
        return state.probe.observed;
    });
}

/**
 * Captures the popup's short-lived exit state before Playwright sends the close click. A loaded CI runner can spend the
 * entire 100ms exit duration between protocol calls, so polling the live locator after the click can observe only the
 * already-unmounted popup even though the animation ran correctly.
 */
async function startOverlayExitProbe(popup: Locator): Promise<void> {
    await popup.evaluate((element) => {
        const probe: {
            animation: { closed: boolean; duration: string; name: string } | null;
        } = { animation: null };
        const observer = new MutationObserver(() => {
            if (!Object.hasOwn(element.dataset, 'closed')) return;
            const style = getComputedStyle(element);
            probe.animation = {
                closed: true,
                duration: style.animationDuration,
                name: style.animationName,
            };
            observer.disconnect();
        });
        observer.observe(element, { attributeFilter: ['data-closed'], attributes: true });
        Object.defineProperty(globalThis, 'overlayExitProbe', {
            configurable: true,
            value: { observer, probe },
        });
    });
}

async function overlayExitAnimationOf(page: Page) {
    const animation = await page.evaluate(() => {
        const state = (
            globalThis as unknown as {
                overlayExitProbe?: {
                    probe: {
                        animation: { closed: boolean; duration: string; name: string } | null;
                    };
                };
            }
        ).overlayExitProbe;
        if (!state) throw new Error('Overlay exit probe was not started');
        return state.probe.animation;
    });
    if (!animation) return null;
    const durationMs = parseDurationMs(animation.duration);
    return durationMs === null
        ? null
        : { closed: animation.closed, durationMs, name: animation.name };
}

/**
 * Lets a live `prefers-reduced-motion` toggle propagate through React before the next assertion.
 */
async function settleMediaPreference(page: Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
}

test('Project disclosure timing derives from motion tokens, unmounts children on collapse, and survives rapid re-expand', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-motion-disclosure-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const toggle = running.page.locator('.project-disclosure');
        const disclosure = running.page.locator('.disclosure-motion[data-disclosure="project"]');
        const content = disclosure.locator('.session-card');

        // Restored startup state renders still: no data-motion until the user toggles it.
        await expect(disclosure).toHaveAttribute('data-expanded', 'true');
        await expect(disclosure).not.toHaveAttribute('data-motion');

        const expandMs = await motionTokenMs(running.page, '--motion-expand');
        const collapseMs = await motionTokenMs(running.page, '--motion-collapse');

        await toggle.click();
        await expect(disclosure).toHaveAttribute('data-expanded', 'false');
        await expect(disclosure).toHaveAttribute('data-motion');
        expect(await transitionDurationMs(disclosure)).toBe(collapseMs);
        // Content stays mounted until the collapse transition settles, then releases — this is
        // the presence cleanup disclosure-motion.tsx documents (transitionend or the token-based
        // fallback), not an immediate unmount on click.
        await expect(content).toHaveCount(0, { timeout: collapseMs + 2_000 });

        await toggle.click();
        await expect(disclosure).toHaveAttribute('data-expanded', 'true');
        expect(await transitionDurationMs(disclosure)).toBe(expandMs);
        await expect(content).toHaveCount(1);

        // Rapid collapse-then-reexpand (no wait for the collapse transition to settle in
        // between) must never leave a stale ghost copy or an inert live copy behind.
        await toggle.click();
        await toggle.click();
        await expect(disclosure).toHaveAttribute('data-expanded', 'true');
        await expect(content).toHaveCount(1);
        await expect(disclosure).toHaveAttribute('aria-hidden', 'false');
        await expect(disclosure).not.toHaveAttribute('inert');
        // The still-mounted content is genuinely interactive, not a disabled ghost.
        const sessionId = await selectedSessionId(running.page);
        await sessionCard(running.page, sessionId).click();
        await expect(sessionCard(running.page, sessionId)).toHaveClass(/active/);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Work tabs animate presence with motion-token durations and switch Sessions instantly', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-motion-tabs-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        const initialTab = running.page.locator('.work-tab[data-terminal-id]').first();
        // The very first tab is the AnimatePresence subtree's first render, so it must never
        // animate in — it is already at full opacity, with no transient state to observe.
        await expect(initialTab).toHaveCSS('opacity', '1');
        // Motion's inline-style animation replaced the old CSS-keyframe attribute entirely.
        await expect(initialTab).not.toHaveAttribute('data-motion');

        const enterMs = await motionTokenMs(running.page, '--motion-tab-enter');
        const exitMs = await motionTokenMs(running.page, '--motion-tab-exit');

        await pressNewTerminal(running.page);
        const addedTab = running.page.locator('.work-tab[data-terminal-id]').last();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);
        /**
         * Both widths are re-read every iteration rather than sampling the sibling once up front. The second tab's
         * arrival also brings back the tab bar's "+" action, hidden while the Workbench holds a single tab, so the rail
         * loses width at the same moment the tabs start sharing it — a `initialWidth` captured before that settles is
         * stale on the high side and the ratio never closes.
         */
        await expect
            .poll(
                async () => {
                    const added = (await addedTab.boundingBox())?.width ?? 0;
                    const initial = (await initialTab.boundingBox())?.width ?? 0;
                    return initial > 0 ? added / initial : 0;
                },
                { timeout: enterMs + 2_000 },
            )
            .toBeGreaterThan(0.9);
        await expect(addedTab).toHaveCSS('opacity', '1');

        await startWorkTabExitProbe(addedTab);
        await addedTab.hover();
        await addedTab.getByRole('button', { name: 'Close Terminal' }).click();
        // The exiting tab is marked inert/aria-hidden immediately, then removed from the DOM
        // once the exit animation settles. Observe that transient state in the browser so the
        // locator cannot retarget the surviving tab after an event-loop stall.
        await expect.poll(() => wasWorkTabExitObserved(running.page)).toBe(true);
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(1, {
            timeout: exitMs + 2_000,
        });

        // Switching Sessions remounts the whole tab strip subtree (`Fragment key={sessionId}`),
        // so the new Session's tabs are never animated in: `AnimatePresence`'s `initial={false}`
        // only suppresses the *first* render of a subtree, and remounting makes every Session
        // switch a first render again.
        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        expect(secondSessionId).not.toBe(firstSessionId);
        const secondSessionTab = running.page.locator('.work-tab[data-terminal-id]').first();
        await expect(secondSessionTab).toHaveCSS('opacity', '1');

        await sessionCard(running.page, firstSessionId).click();
        const restoredTab = running.page.locator('.work-tab[data-terminal-id]').first();
        await expect(restoredTab).toHaveCSS('opacity', '1');
        expect(
            await restoredTab.evaluate((element) => getComputedStyle(element).maxWidth),
        ).not.toBe('0px');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Overlay popups animate with --motion-overlay-enter/--motion-overlay-exit token durations', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-motion-overlay-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        /**
         * This case verifies the normal-motion contract independently from the macOS runner's accessibility setting.
         */
        await running.page.emulateMedia({ reducedMotion: 'no-preference' });
        await createProjectSession(running.page);
        const enterMs = await motionTokenMs(running.page, '--motion-overlay-enter');
        const exitMs = await motionTokenMs(running.page, '--motion-overlay-exit');

        // Settings itself stopped being an animated overlay Dialog (issue caxri#1289): it is
        // a persistent Workbench tab now, with no `data-open`/`data-closed` popup lifecycle to
        // probe. The Archived Sessions manager, opened from a row inside Settings, is still a real
        // Dialog built on the same shared overlay primitive and motion tokens, so it stands in here
        // for the generic `--motion-overlay-enter`/`-exit` contract — nothing below depends on what
        // the dialog's own content is.
        const settingsTab = await openSettingsTab(running.page);
        await settingsTab.locator('.archived-sessions-entry').click();
        // The manager floats over Settings rather than closing it first: Settings is a Workbench
        // tab now, not a dialog, so there is no modal layer underneath it to clear.
        await expect(settingsTab).toBeVisible();
        const dialogPopup = running.page.getByRole('dialog');
        await expect(dialogPopup).toContainText('Archived Sessions');
        await expect(dialogPopup).toHaveAttribute('data-open', '');
        expect(await animationNameOf(dialogPopup)).toBe('enter');
        expect(await animationDurationMs(dialogPopup)).toBe(enterMs);

        await startOverlayExitProbe(dialogPopup);
        await dialogPopup.getByRole('button', { name: 'Close', exact: true }).click();
        /**
         * Base UI exposes `data-closed` only during the exit animation. The browser-side probe records that state and
         * both computed animation fields atomically before the popup unmounts.
         */
        const exitAnimation = await pollUntil(
            () => overlayExitAnimationOf(running.page),
            (state) => state.closed && state.name === 'exit' && state.durationMs === exitMs,
            { message: 'Archived Sessions dialog exit animation', timeout: exitMs + 2_000 },
        );
        expect(exitAnimation).toEqual({ closed: true, durationMs: exitMs, name: 'exit' });
        await expect(dialogPopup).toHaveCount(0, { timeout: exitMs + 2_000 });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('prefers-reduced-motion completes disclosure and work-tab motion instantly', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-motion-reduced-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        /**
         * The default-Terminal dialog retains its closed overlay until the exit animation ends.
         */
        await expect(running.page.getByRole('dialog')).toHaveCount(0);
        await running.page.emulateMedia({ reducedMotion: 'reduce' });
        await settleMediaPreference(running.page);

        // Disclosure: the CSS transition-duration collapses to 0s...
        const toggle = running.page.locator('.project-disclosure');
        const disclosure = running.page.locator('.disclosure-motion[data-disclosure="project"]');
        const content = disclosure.locator('.session-card');
        await toggle.click();
        await expect(disclosure).toHaveAttribute('data-expanded', 'false');
        expect(await transitionDurationMs(disclosure)).toBe(0);
        // ...and separately, `motionEnabled` (animate && !reducedMotion) is false, so
        // DisclosureMotion drops the exit-presence retention entirely and unmounts content in
        // the very same commit as the collapse — asserted with no wait, since there is no
        // settle window left to poll for.
        expect(await content.count()).toBe(0);
        await toggle.click();
        await expect(disclosure).toHaveAttribute('data-expanded', 'true');
        await expect(content).toHaveCount(1);

        // Work tabs: presence still changes correctly, with no animation to wait through.
        await pressNewTerminal(running.page);
        const reducedTab = running.page.locator('.work-tab[data-terminal-id]').last();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);
        await expect(reducedTab).toHaveCSS('opacity', '1');
        await reducedTab.hover();
        await reducedTab.getByRole('button', { name: 'Close Terminal' }).click();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * KNOWN FAILING — implementation bug, not a test bug (see the final report for full diagnosis).
 * `motion-reduce:animate-none` (`.motion-reduce\:animate-none { animation: none }`, specificity 0-1-0 inside `@media
 * (prefers-reduced-motion: reduce)`) never wins the cascade against `data-open:animate-in[data-open]` /
 * `data-closed:animate-out[data-closed]` (specificity 0-2-0, from the extra attribute selector), so every
 * `components/ui/*` overlay (dialog, select, context-menu, tooltip) keeps animating at full
 * `--motion-overlay-enter`/`-exit` duration under `prefers-reduced-motion: reduce`, contradicting DESIGN.md's Motion
 * contract.
 */
test('prefers-reduced-motion disables the overlay keyframe animation', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-motion-reduced-overlay-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await expect(running.page.getByRole('dialog')).toHaveCount(0);
        await running.page.emulateMedia({ reducedMotion: 'reduce' });
        await settleMediaPreference(running.page);

        // Settings itself stopped being an animated overlay Dialog (issue caxri#1289); see the
        // comment on the equivalent step above for why the Archived Sessions manager, opened from a
        // row inside Settings, stands in here for the generic overlay keyframe contract instead.
        const settingsTab = await openSettingsTab(running.page);
        await settingsTab.locator('.archived-sessions-entry').click();
        await expect(settingsTab).toBeVisible();
        const dialogPopup = running.page.getByRole('dialog');
        await expect(dialogPopup).toBeVisible();
        expect(await animationNameOf(dialogPopup)).toBe('none');
        await dialogPopup.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(dialogPopup).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Files directory tree expands instantly with no disclosure-motion wrapper', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-motion-files-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', join(root, 'subdir')]);
    await writeFile(join(root, 'subdir', 'example.txt'), 'hello\n');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const filesPanel = running.page.locator('.secondary-sidebar');
        await expect(filesPanel.locator('.file-list .tree-row')).toHaveCount(1);
        // Files tree items are intentionally instant (lazy fetch, no spatial continuity to
        // explain), so the tree never wraps its children in the shared presence layer.
        await expect(filesPanel.locator('.disclosure-motion')).toHaveCount(0);

        const directoryRow = filesPanel.getByRole('treeitem', { name: 'subdir' });
        await directoryRow.click();
        const fileRow = filesPanel.getByRole('treeitem', { name: 'example.txt' });
        await expect(fileRow).toBeVisible();
        await expect(filesPanel.locator('.disclosure-motion')).toHaveCount(0);

        // Opening the file still goes through the shared Motion tab-enter path.
        await fileRow.dblclick();
        const editorTab = running.page.locator('.work-tab:not([data-terminal-id])').last();
        await expect(editorTab).toHaveCSS('opacity', '1');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
