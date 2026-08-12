import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
} from './helpers.ts';

const execFileAsync = promisify(execFile);

/**
 * Mirrors `lib/motion.ts`'s `motionDurationMs` parsing so a `--motion-*` token and a computed
 * CSS duration (which the browser normalizes to a different unit/precision, e.g. `130ms` vs
 * `0.13s`) compare as numbers instead of as strings. Every expected timing in this spec is
 * derived from a token through this helper — never a hardcoded millisecond literal, per the
 * DESIGN.md "Motion" contract this suite verifies.
 */
function parseDurationMs(raw: string): number {
    const match = /^(?<value>[\d.]+)(?<unit>m?s)$/.exec(raw.trim());
    if (!match?.groups) throw new Error(`Unparsable CSS duration: "${raw}"`);
    const value = Number(match.groups.value);
    return match.groups.unit === 's' ? value * 1000 : value;
}

async function motionTokenMs(page: Page, token: string): Promise<number> {
    const raw = await page.evaluate(
        (name) => getComputedStyle(document.documentElement).getPropertyValue(name),
        token,
    );
    return parseDurationMs(raw);
}

async function transitionDurationMs(locator: Locator): Promise<number> {
    const raw = await locator.evaluate((element) => getComputedStyle(element).transitionDuration);
    return parseDurationMs(raw);
}

async function animationDurationMs(locator: Locator): Promise<number> {
    const raw = await locator.evaluate((element) => getComputedStyle(element).animationDuration);
    return parseDurationMs(raw);
}

async function animationNameOf(locator: Locator): Promise<string> {
    return locator.evaluate((element) => getComputedStyle(element).animationName);
}

/** Lets a live `prefers-reduced-motion` toggle propagate through React before the next assertion. */
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
        // the presence cleanup DisclosureMotion.tsx documents (transitionend or the token-based
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
        await running.app.close().catch(() => undefined);
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

        await running.page.getByRole('button', { name: 'New Terminal', exact: true }).click();
        const addedTab = running.page.locator('.work-tab[data-terminal-id]').last();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);
        const initialWidth = (await initialTab.boundingBox())!.width;
        await expect
            .poll(async () => (await addedTab.boundingBox())?.width ?? 0, {
                timeout: enterMs + 2_000,
            })
            .toBeGreaterThan(initialWidth * 0.9);
        await expect(addedTab).toHaveCSS('opacity', '1');

        await addedTab.hover();
        await addedTab.getByRole('button', { name: 'Close Terminal' }).click();
        // The exiting tab is marked inert/aria-hidden immediately, then removed from the DOM
        // once the exit animation settles.
        await expect(addedTab).toHaveAttribute('aria-hidden', 'true');
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
        await running.app.close().catch(() => undefined);
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
        await createProjectSession(running.page);
        // The "Choose the default Terminal" dialog from project creation stays mounted with
        // data-closed until its own exit animation finishes (dialog.tsx); wait it out so it
        // cannot coexist with the Settings dialog this test opens next.
        await expect(running.page.getByRole('dialog')).toHaveCount(0);
        const enterMs = await motionTokenMs(running.page, '--motion-overlay-enter');
        const exitMs = await motionTokenMs(running.page, '--motion-overlay-exit');

        await running.page.keyboard.press('Meta+,');
        const dialogPopup = running.page.getByRole('dialog');
        await expect(dialogPopup).toContainText('Settings');
        await expect(dialogPopup).toHaveAttribute('data-open', '');
        expect(await animationNameOf(dialogPopup)).toBe('enter');
        expect(await animationDurationMs(dialogPopup)).toBe(enterMs);

        // Close through the dialog's own Close button rather than Escape: the just-created
        // Session leaves its Terminal focused (`e2e/settings.e2e.ts`'s "Settings shortcut opens
        // while Terminal input has focus" documents that opening Settings via the keyboard
        // shortcut does not steal focus into the dialog), so Escape would be delivered to the
        // Terminal instead of the dialog and never close it.
        await dialogPopup.getByRole('button', { name: 'Close' }).click();
        // Base UI keeps the popup mounted with data-closed set until its exit animation
        // finishes (dialog.tsx documents this), so the exit keyframe/duration is observable in
        // that window before the element unmounts.
        await expect(dialogPopup).toHaveAttribute('data-closed', '');
        expect(await animationNameOf(dialogPopup)).toBe('exit');
        expect(await animationDurationMs(dialogPopup)).toBe(exitMs);
        await expect(dialogPopup).toHaveCount(0, { timeout: exitMs + 2_000 });
    } finally {
        await running.app.close().catch(() => undefined);
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
        /** The default-Terminal dialog retains its closed overlay until the exit animation ends. */
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
        await running.page.getByRole('button', { name: 'New Terminal', exact: true }).click();
        const reducedTab = running.page.locator('.work-tab[data-terminal-id]').last();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);
        await expect(reducedTab).toHaveCSS('opacity', '1');
        await reducedTab.hover();
        await reducedTab.getByRole('button', { name: 'Close Terminal' }).click();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * KNOWN FAILING — implementation bug, not a test bug (see the final report for full diagnosis).
 * `motion-reduce:animate-none` (`.motion-reduce\:animate-none { animation: none }`, specificity
 * 0-1-0 inside `@media (prefers-reduced-motion: reduce)`) never wins the cascade against
 * `data-open:animate-in[data-open]` / `data-closed:animate-out[data-closed]` (specificity 0-2-0,
 * from the extra attribute selector), so every `components/ui/*` overlay (dialog, select,
 * context-menu, tooltip) keeps animating at full `--motion-overlay-enter`/`-exit` duration under
 * `prefers-reduced-motion: reduce`, contradicting DESIGN.md's Motion contract.
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

        await running.page.keyboard.press('Meta+,');
        const dialogPopup = running.page.getByRole('dialog');
        await expect(dialogPopup).toBeVisible();
        expect(await animationNameOf(dialogPopup)).toBe('none');
        await dialogPopup.getByRole('button', { name: 'Close' }).click();
        await expect(dialogPopup).toHaveCount(0);
    } finally {
        await running.app.close().catch(() => undefined);
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
        const filesPanel = running.page.locator('.inspector');
        await expect(filesPanel.locator('.file-list .tree-row')).toHaveCount(1);
        // Files is the one user-triggered disclosure DESIGN.md keeps intentionally instant
        // (lazy fetch, no spatial continuity to explain): confirm the tree never wraps its
        // children in the shared presence layer that every other disclosure site uses.
        await expect(filesPanel.locator('.disclosure-motion')).toHaveCount(0);

        const directoryRow = filesPanel.getByRole('button', { name: 'subdir' });
        await directoryRow.click();
        const fileRow = filesPanel.getByRole('button', { name: 'example.txt' });
        await expect(fileRow).toBeVisible();
        await expect(filesPanel.locator('.disclosure-motion')).toHaveCount(0);

        // Opening the file still goes through the shared Motion tab-enter path.
        await fileRow.dblclick();
        const editorTab = running.page.locator('.work-tab:not([data-terminal-id])').last();
        await expect(editorTab).toHaveCSS('opacity', '1');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
