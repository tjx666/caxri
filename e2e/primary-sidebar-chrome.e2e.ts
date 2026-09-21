import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import { publishFullScreenState } from './support/full-screen-state.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    pressNewTerminal,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';

const MESSAGE_BOX_CALL_COUNT_KEY = '__caxriE2EMessageBoxCallCount';

/**
 * Closes the Electron app during teardown without letting an already-closed app fail the test.
 */
async function closeAppQuietly(app: E2EApp): Promise<void> {
    try {
        await app.close();
    } catch {
        // Ignore close failures during cleanup.
    }
}

async function stubMessageBoxResponse(app: E2EApp, response: number): Promise<void> {
    await app.evaluate(({ dialog }, nextResponse) => {
        Reflect.set(globalThis, '__caxriE2EMessageBoxCallCount', 0);
        dialog.showMessageBox = () => {
            const calls = Number(Reflect.get(globalThis, '__caxriE2EMessageBoxCallCount') ?? 0);
            Reflect.set(globalThis, '__caxriE2EMessageBoxCallCount', calls + 1);
            return Promise.resolve({ response: nextResponse, checkboxChecked: false });
        };
    }, response);
}

/**
 * A row that remains visible does not prove its canceled deletion request completed. Wait until Main consumes the
 * native-dialog response before replacing the stub for a subsequent request.
 */
async function waitForMessageBoxCall(app: E2EApp): Promise<void> {
    await expect
        .poll(() =>
            app.evaluate(
                (_electron, key) => Number(Reflect.get(globalThis, key) ?? 0),
                MESSAGE_BOX_CALL_COUNT_KEY,
            ),
        )
        .toBe(1);
}

test('primarySidebar titlebar is logo-free, holds only the Session history pair, and stays draggable', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-titlebar-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const titlebar = running.page.locator('.primary-sidebar-title');
        await expect(titlebar.locator('[data-caxri-logo]')).toHaveCount(0);
        // The Add Project entry points are the `Cmd+O` shortcut, the Project menu, and the command
        // palette; the Session history pair is the only control the titlebar carries, and it opts
        // out of the drag region so the buttons navigate instead of moving the window.
        await expect(titlebar.getByRole('button')).toHaveCount(2);
        await expect(titlebar.locator('[data-session-history="back"]')).toHaveCount(1);
        await expect(titlebar.locator('[data-session-history="forward"]')).toHaveCount(1);
        expect(
            await titlebar
                .locator('.session-history-navigation')
                .evaluate((element) =>
                    getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                ),
        ).toBe('no-drag');
        const titlebarMetrics = await titlebar.evaluate((element) => {
            const titlebarBounds = element.getBoundingClientRect();
            return {
                appRegion: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                height: titlebarBounds.height,
            };
        });
        expect(titlebarMetrics).toMatchObject({ appRegion: 'drag', height: 44 });
        expect(
            await running.app.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
            ),
        ).toEqual({ x: 15, y: 15 });

        // macOS hides the traffic lights in fullscreen; the logo takes their place.
        await publishFullScreenState(running.app, true);
        const logo = titlebar.locator('img[data-caxri-logo]');
        await expect(logo).toHaveCount(1);
        await expect(logo).toHaveAttribute('alt', 'Caxri');
        await expect(logo).toBeVisible();
        await expect(titlebar).toHaveCSS('padding-left', '12px');

        await publishFullScreenState(running.app, false);
        await expect(titlebar.locator('[data-caxri-logo]')).toHaveCount(0);
        await expect(titlebar).toHaveCSS('padding-left', '84px');
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('active and inactive Project navigation keeps full contrast', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-primary-sidebar-contrast-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await createAdditionalShellSession(running.page);

        const projectHeading = running.page.locator('.project-heading');
        const restingBackground = await projectHeading.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
        );
        expect(restingBackground).toBe('rgba(0, 0, 0, 0)');
        await projectHeading.hover();
        await expect
            .poll(() =>
                projectHeading.evaluate((element) => getComputedStyle(element).backgroundColor),
            )
            .not.toBe(restingBackground);
        await running.page.mouse.move(500, 300);

        const cards = running.page.locator('.session-card');
        await expect(cards).toHaveCount(2);
        const colors = await Promise.all([
            running.page
                .locator('.project-heading')
                .evaluate((element) => getComputedStyle(element).color),
            cards.nth(0).evaluate((element) => getComputedStyle(element).color),
            cards.nth(1).evaluate((element) => getComputedStyle(element).color),
        ]);
        expect(new Set(colors).size).toBe(1);
        const backgrounds = await Promise.all([
            cards.nth(0).evaluate((element) => getComputedStyle(element).backgroundColor),
            cards.nth(1).evaluate((element) => getComputedStyle(element).backgroundColor),
        ]);
        expect(backgrounds[0]).not.toBe(backgrounds[1]);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Project details move to a hover card and idle Session titles reclaim the empty status slot', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-details-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    const canonicalRoot = await realpath(root);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const sessionId = await createProjectSession(running.page);
        const title = 'Production build failed because GitHub account authentication needs review';
        await pageRequest(running.page, 'session.rename', { sessionId, displayTitle: title });

        const projectHeading = running.page.locator('.project-heading');
        const projectTitle = projectHeading.locator('.project-select');
        await expect(projectHeading.locator('.project-session-count')).toHaveCount(0);
        await expect(projectTitle).toHaveAccessibleName('project (1 Session)');

        await projectTitle.hover();
        const projectCard = running.page.locator('.project-details-card');
        await expect(projectCard).toBeVisible();
        await expect(projectCard.getByRole('heading', { name: 'project' })).toBeVisible();
        await expect(projectCard.getByText('1 active Session', { exact: true })).toBeVisible();
        await expect(projectCard.getByText(canonicalRoot, { exact: true })).toBeVisible();

        await projectTitle.click({ button: 'right' });
        await expect(running.page.getByRole('menu', { name: 'project actions' })).toBeVisible();
        await expect(projectCard).not.toBeVisible();
        await running.page.keyboard.press('Escape');

        await running.page.mouse.move(500, 300);
        await expect(projectCard).not.toBeVisible();
        const card = sessionCard(running.page, sessionId);
        await card.focus();
        await running.page.keyboard.press('ArrowUp');
        await expect(projectTitle).toBeFocused();
        await expect(projectCard).toBeVisible({ timeout: 200 });
        await expect(running.page.locator('.session-activity-card')).not.toBeVisible();

        const metrics = await card.evaluate((element) => {
            const titleViewport = element.querySelector<HTMLElement>('.session-title');
            const titleText = titleViewport?.firstElementChild as HTMLElement | null;
            const indicators = element.querySelector<HTMLElement>('.session-indicators');
            if (!titleViewport || !titleText || !indicators)
                throw new Error('Session title metrics are unavailable');
            return {
                indicatorWidth: indicators.getBoundingClientRect().width,
                titleOverflow: titleText.scrollWidth - titleText.clientWidth,
            };
        });
        expect(metrics.indicatorWidth).toBe(0);
        expect(metrics.titleOverflow).toBeGreaterThan(0);

        await running.page.screenshot({
            path: test.info().outputPath('project-details-and-session-width.png'),
        });
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Session rows support keyboard selection independently from rename', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-keyboard-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        expect(secondSessionId).not.toBe(firstSessionId);

        const firstCard = sessionCard(running.page, firstSessionId);
        const newSession = running.page.getByRole('button', {
            name: 'New Session in project',
        });
        const disclosure = running.page.locator('.project-disclosure');
        // The PrimarySidebar tree collapses to a single roving Tab stop: inner controls stay
        // mouse/arrow-key accessible but leave the Tab order entirely.
        await expect(newSession).toHaveAttribute('tabindex', '-1');
        await expect(disclosure).toHaveAttribute('tabindex', '-1');

        await running.page.locator('.project-select').focus();
        await running.page.keyboard.press('ArrowDown');
        const secondCard = sessionCard(running.page, secondSessionId);
        await expect(secondCard).toBeFocused();
        expect(
            await secondCard.evaluate((element) => getComputedStyle(element).boxShadow),
        ).not.toBe('none');

        const archivedEntry = running.page.locator('aside .archived-sessions-entry');
        await expect(archivedEntry).toBeVisible();
        await expect(archivedEntry).toHaveAccessibleName('Archived Sessions (0)');

        // The tree keeps one roving Tab stop, followed by the always-visible global archive entry.
        await firstCard.focus();
        await running.page.keyboard.press('Tab');
        await expect(archivedEntry).toBeFocused();

        await firstCard.focus();
        await firstCard.press('Space');
        await expect(firstCard).toHaveClass(/active/);
        expect(await selectedSessionId(running.page)).toBe(firstSessionId);
        await expect(running.page.locator('.xterm-helper-textarea')).toBeFocused();

        // Delete is the keyboard equivalent of the per-row Archive button.
        // Archiving the focused row must not throw focus out of the tree: it lands on a neighbor
        // row. Target the *non-selected* second card so the selection stays put — archiving the
        // selected Session would re-select another one, whose Terminal would then claim focus by
        // design (same rationale as the Tab assertion above). Session Activity ordering puts the
        // newer second card first, so focus falls forward to the first-created card below it.
        await secondCard.focus();
        await running.page.keyboard.press('Delete');
        await expect(secondCard).toHaveCount(0);
        await expect(firstCard).toBeFocused();
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Files actions stay visible while Project actions reveal on hover or focus', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-primary-sidebar-affordances-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const caption = running.page.locator('.panel-caption');
        const captionTitle = caption.locator('.panel-caption-title');
        const fileActionNames = ['New File', 'New Folder', 'Refresh Files', 'Collapse Folders'];
        await expect(captionTitle).toHaveText('project');
        await expect(captionTitle).toHaveAttribute('title', await realpath(root));
        await Promise.all(
            fileActionNames.map((name) =>
                expect(caption.getByRole('button', { name })).toHaveCSS('opacity', '1'),
            ),
        );
        await running.page.mouse.move(500, 300);
        await Promise.all(
            fileActionNames.map((name) =>
                expect(caption.getByRole('button', { name })).toHaveCSS('opacity', '1'),
            ),
        );

        const projectHeading = running.page.locator('.project-heading');
        const newSession = projectHeading.getByRole('button', { name: 'New Session in project' });
        const projectDisclosure = projectHeading.getByRole('button', {
            name: 'Collapse project',
        });
        await expect(projectHeading.locator('.project-disclosure')).toHaveCount(1);
        // The chevron carries the disclosure state; the folder glyph sits beside the Project name as identity and a
        // custom icon replaces it there without taking the cue away (issue #993).
        await expect(projectDisclosure.locator('svg')).toHaveClass(/lucide-chevron-down/);
        await expect(projectHeading.locator('.project-select .project-folder-icon')).toHaveClass(
            /lucide-folder-open/,
        );
        await projectDisclosure.click();
        const collapsedDisclosure = projectHeading.getByRole('button', {
            name: 'Expand project',
        });
        await expect(collapsedDisclosure.locator('svg')).toHaveClass(/lucide-chevron-right/);
        await expect(projectHeading.locator('.project-select .project-folder-icon')).toHaveClass(
            /lucide-folder-closed/,
        );
        await collapsedDisclosure.click();
        // The heading names its Session count, so the accessible name is never the bare title.
        const projectName = projectHeading.getByRole('treeitem', { name: 'project (1 Session)' });
        await projectName.click();
        await expect(projectHeading.getByRole('button', { name: 'Expand project' })).toBeVisible();
        await expect(running.page.locator('.project-session-disclosure')).toHaveAttribute(
            'data-expanded',
            'false',
        );
        await projectName.click();
        await expect(
            projectHeading.getByRole('button', { name: 'Collapse project' }),
        ).toBeVisible();
        await expect(running.page.locator('.session-list')).toBeVisible();
        const selectedSession = running.page.locator('.session-card.active');
        await selectedSession.focus();
        await expect(selectedSession).toHaveCSS('box-shadow', 'none');
        await running.page.mouse.move(500, 300);
        await expect(newSession).toHaveCSS('opacity', '0');
        await projectHeading.hover();
        await expect(newSession).toHaveCSS('opacity', '1');
        await running.page.mouse.move(500, 300);
        await newSession.focus();
        await expect(newSession).toHaveCSS('opacity', '1');
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Project titles toggle disclosure when no active Session can be selected', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-empty-project-heading-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const activeRoot = join(testDirectory, 'active-project');
    const emptyRoot = join(testDirectory, 'empty-project');
    await Promise.all([
        execFileAsync('mkdir', ['-p', activeRoot]),
        execFileAsync('mkdir', ['-p', emptyRoot]),
    ]);
    const [canonicalActiveRoot, canonicalEmptyRoot] = await Promise.all([
        realpath(activeRoot),
        realpath(emptyRoot),
    ]);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: activeRoot,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify([activeRoot, emptyRoot]) },
    });
    try {
        await createProjectSession(running.page);
        const activeSessionId = await selectedSessionId(running.page);
        const selectedRoot = await pageRequest<string | null>(
            running.page,
            'dialog.selectDirectory',
        );
        expect(selectedRoot).toBe(emptyRoot);
        await pageRequest(running.page, 'project.create', { rootPath: selectedRoot });
        await expect(running.page.locator('.project-heading')).toHaveCount(2);

        const bootstrap = await pageRequest<{
            projects: Array<{ displayTitle: string; id: string; rootPath: string }>;
            sessions: Array<{ archivedAt?: number; id: string; projectId: string }>;
        }>(running.page, 'app.bootstrap');
        const activeProject = bootstrap.projects.find(
            (project) => project.rootPath === canonicalActiveRoot,
        );
        const emptyProject = bootstrap.projects.find(
            (project) => project.rootPath === canonicalEmptyRoot,
        );
        if (!activeProject || !emptyProject) throw new Error('Expected both E2E Projects');
        expect(
            bootstrap.sessions.filter((session) => session.projectId === emptyProject.id),
        ).toHaveLength(0);

        const emptyHeading = running.page.locator(
            `.project-heading[data-project-id="${emptyProject.id}"]`,
        );
        // Located by class rather than accessible name: the name now carries a live Session count, which this test
        // changes as it archives. `project-heading.test.ts` owns the wording.
        const emptyTitle = emptyHeading.locator('.project-select');
        const emptyDisclosure = emptyHeading.locator('.project-disclosure');
        await expect(emptyTitle).toHaveAttribute('aria-expanded', 'true');
        await expect(emptyDisclosure).toHaveAttribute('aria-expanded', 'true');
        await emptyTitle.click();
        await expect(emptyTitle).toHaveAttribute('aria-expanded', 'false');
        await expect(emptyDisclosure).toHaveAttribute('aria-expanded', 'false');
        expect(await selectedSessionId(running.page)).toBe(activeSessionId);
        await expect(running.page.getByRole('dialog')).toHaveCount(0);

        await emptyTitle.focus();
        await emptyTitle.press('Enter');
        await expect(emptyTitle).toBeFocused();
        await expect(emptyTitle).toHaveAttribute('aria-expanded', 'true');
        await expect(emptyDisclosure).toHaveAttribute('aria-expanded', 'true');

        const activeRow = sessionCard(running.page, activeSessionId).locator('..');
        await activeRow.hover();
        await activeRow.getByRole('button', { name: /^Archive / }).click();
        await expect(sessionCard(running.page, activeSessionId)).toHaveCount(0);
        const archivedSnapshot = await pageRequest<{
            sessions: Array<{ archivedAt?: number; id: string }>;
        }>(running.page, 'app.bootstrap');
        expect(
            archivedSnapshot.sessions.find((session) => session.id === activeSessionId)?.archivedAt,
        ).toEqual(expect.any(Number));

        const activeHeading = running.page.locator(
            `.project-heading[data-project-id="${activeProject.id}"]`,
        );
        const activeTitle = activeHeading.locator('.project-select');
        const activeDisclosure = activeHeading.locator('.project-disclosure');
        await expect(activeTitle).toHaveAttribute('aria-expanded', 'true');
        await activeTitle.click();
        await expect(activeTitle).toHaveAttribute('aria-expanded', 'false');
        await expect(activeDisclosure).toHaveAttribute('aria-expanded', 'false');
        await expect(running.page.getByRole('dialog')).toHaveCount(0);
        const finalSnapshot = await pageRequest<{ sessions: Array<{ id: string }> }>(
            running.page,
            'app.bootstrap',
        );
        expect(finalSnapshot.sessions).toHaveLength(1);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('work tabs divide evenly, leave a draggable titlebar, and pin New Terminal against the sidebar', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const strip = running.page.locator('.work-tabs');
        const tab = strip.locator('.work-tab').last();
        const actions = strip.locator('.tab-actions');
        // The bar drops its "+" chrome entirely while the Workbench holds a single tab, so the geometry this test is
        // about only exists once a second tab makes the button meaningful.
        await expect(actions).toHaveCount(0);
        await pressNewTerminal(running.page);
        await expect(strip.locator('.work-tab')).toHaveCount(2);
        const metrics = await Promise.all([
            strip.evaluate((element) => ({
                region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                right: element.getBoundingClientRect().right,
            })),
            tab.evaluate((element) => ({
                region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                right: element.getBoundingClientRect().right,
            })),
            actions.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return {
                    left: bounds.left,
                    region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                    right: bounds.right,
                };
            }),
        ]);

        expect(metrics[0].region).toBe('drag');
        expect(metrics[1].region).toBe('no-drag');
        expect(metrics[2].region).toBe('no-drag');
        // Tabs run straight into "+" the way iTerm2 does, with no dead strip wedged between the last tab and the
        // button, so the button stays reachable instead of scrolling out of view behind evenly divided Terminals.
        expect(metrics[2].left - metrics[1].right).toBeLessThanOrEqual(1);
        // "+" also ends the bar. The window still moves by its titlebar because `primary-sidebar-title` above is a
        // drag region of its own; the bar reserves a grabbable corner only once the sidebar is hidden and it is the
        // whole titlebar (`work-tab-sizing.e2e.ts`).
        expect(metrics[0].right - metrics[2].right).toBeLessThanOrEqual(1);
        const isActionsOutsideScrollRail = await running.page
            .locator('.work-tab-scroll')
            .evaluate((element) => !element.contains(document.querySelector('.tab-actions')));
        expect(isActionsOutsideScrollRail).toBe(true);
        await expect(running.page.getByRole('button', { name: 'Split Terminal' })).toHaveCount(0);

        // Terminal tabs divide the rail evenly (iTerm2/Chrome), so a tab's position depends on the tab
        // count alone and Command+1..9 keeps a stable spatial meaning.
        await expect
            .poll(async () =>
                strip.evaluate((element) => {
                    const widths = [...element.querySelectorAll('.work-tab')].map(
                        (tab) => tab.getBoundingClientRect().width,
                    );
                    return Math.round(Math.max(...widths) - Math.min(...widths));
                }),
            )
            .toBeLessThanOrEqual(1);

        const alignedBottoms = async (...selectors: string[]) =>
            Promise.all(
                selectors.map((selector) =>
                    running.page
                        .locator(selector)
                        .evaluate((element) => element.getBoundingClientRect().bottom),
                ),
            );
        const assertAligned = (values: number[]): void => {
            expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
        };
        assertAligned(
            await alignedBottoms(
                '.primary-sidebar-title',
                '.work-tabs',
                '[role="tablist"][aria-label="Secondary Side Bar"]',
            ),
        );
        await running.page.keyboard.press('Meta+[');
        assertAligned(
            await alignedBottoms(
                '.collapsed-primary-sidebar-titlebar',
                '.work-tabs',
                '[role="tablist"][aria-label="Secondary Side Bar"]',
            ),
        );
        await running.page.keyboard.press('Meta+[');
        await running.page.keyboard.press('Meta+]');
        assertAligned(await alignedBottoms('.primary-sidebar-title', '.work-tabs'));
        await running.page.keyboard.press('Meta+]');

        // A tab whose title fits offers no tooltip: repeating a label the user can already read is noise.
        // `work-tab-sizing.e2e.ts` also verifies that crowded tabs preserve their displayed titles and scroll.
        const terminalTab = strip.locator('.work-tab[data-terminal-id] .tab-select').first();
        const isLabelClipped = await terminalTab
            .locator('.tab-label')
            .evaluate((element) => element.scrollWidth > element.clientWidth);
        expect(isLabelClipped).toBe(false);
        await terminalTab.hover();
        // Asked of the tab itself rather than by counting open popups anywhere on the page, which revealing the
        // Secondary Side Bar now spoils: it hands the keyboard to its selected icon-only tab, whose tooltip is open on
        // purpose for as long as it holds focus. Base UI drops `data-base-ui-tooltip-trigger` from a trigger with no
        // tooltip to give, so this settles immediately instead of waiting out a 500 ms delay that proves nothing.
        await expect(terminalTab).not.toHaveAttribute('data-base-ui-tooltip-trigger');
        await running.page.mouse.move(0, 300);

        // E2E runs with no `session.defaultAgent`, so New Terminal collapses to the single button that asks which
        // Agent to start. It advertises no ⌘T there: the shortcut falls back to a plain shell instead of asking.
        const newTerminal = running.page.getByRole('button', { name: 'New Terminal' });
        await newTerminal.hover();
        await expect(newTerminal).not.toHaveAttribute('data-base-ui-tooltip-trigger');
        await newTerminal.click();
        // Named after the button that opened it: Base UI points the popup's `aria-labelledby` at its active trigger,
        // which outranks any `aria-label` the popup carries. `Select a different agent` names the split button's
        // chevron, and that half only exists once `session.defaultAgent` is configured.
        const agentMenu = running.page.getByRole('menu', { name: 'New Terminal' });
        await expect(agentMenu).toBeVisible();
        await expect(agentMenu.getByRole('menuitem')).toHaveText([
            'Claude Code',
            'Codex',
            'Grok Build',
            'Shell',
        ]);
        await running.page.keyboard.press('Escape');
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Session archive hides active navigation, parks its Terminals, and restores on selection', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-archive-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        await pageRequest(running.page, 'session.rename', {
            sessionId: secondSessionId,
            displayTitle: 'Archived investigation',
        });
        await expect(sessionCard(running.page, secondSessionId)).toContainText(
            'Archived investigation',
        );
        await expect(running.page.locator('.session-card')).toHaveCount(2);
        const runningCount = () => pageRequest<number>(running.page, 'terminal.runningCount');
        const runningBeforeArchive = await runningCount();

        const secondRow = sessionCard(running.page, secondSessionId).locator('..');
        await secondRow.hover();
        await secondRow.getByRole('button', { name: /^Archive / }).click();

        await expect(sessionCard(running.page, secondSessionId)).toHaveCount(0);
        await expect(sessionCard(running.page, firstSessionId)).toHaveClass(/active/);
        // An archived Session has no viewer, so its live Terminal is parked (suspended) rather than kept resident.
        await expect.poll(runningCount).toBe(runningBeforeArchive - 1);
        await expect(running.page.locator('.project-group .archived-sessions')).toHaveCount(0);
        const archivedEntry = running.page.locator('aside .archived-sessions-entry');
        await expect(archivedEntry).toHaveAccessibleName('Archived Sessions (1)');
        await archivedEntry.click();
        const dialog = running.page.getByRole('dialog');
        await expect(dialog.getByRole('heading', { name: 'Archived Sessions' })).toBeVisible();
        await dialog.getByLabel('Search').fill('investigation');
        await dialog.getByLabel('Filter by Project').click();
        await running.page.getByRole('option', { name: 'project', exact: true }).click();
        await dialog.getByLabel('Filter by Agent').click();
        await running.page.getByRole('option', { name: 'Shell', exact: true }).click();
        await expect(dialog.locator('.archived-manager-row')).toHaveCount(1);
        const restore = dialog.getByRole('button', { name: 'Restore Archived investigation' });
        await restore.click();

        await expect(running.page.locator('.session-card')).toHaveCount(2);
        await dialog.getByRole('button', { name: 'Done' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(archivedEntry).toHaveAccessibleName('Archived Sessions (0)');
        // Restoring alone leaves the Terminal parked; selecting the Session relaunches it.
        await sessionCard(running.page, secondSessionId).click();
        await expect(sessionCard(running.page, secondSessionId)).toHaveClass(/active/);
        await expect.poll(runningCount).toBe(runningBeforeArchive);
        const snapshot = await pageRequest<{
            sessions: Array<{ archivedAt?: number; id: string }>;
        }>(running.page, 'app.bootstrap');
        expect(
            snapshot.sessions.find((session) => session.id === secondSessionId)?.archivedAt,
        ).toBe(undefined);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Archived Sessions manager deletes only after native confirmation', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-archive-delete-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await createAdditionalShellSession(running.page);
        const archivedSessionId = await selectedSessionId(running.page);

        const archivedSourceRow = sessionCard(running.page, archivedSessionId).locator('..');
        await archivedSourceRow.hover();
        await archivedSourceRow.getByRole('button', { name: /^Archive / }).click();
        await expect(sessionCard(running.page, archivedSessionId)).toHaveCount(0);

        // The manager's global entry point lives in Settings now, not in the primarySidebar.
        await running.page.keyboard.press('Meta+,');
        const settingsDialog = running.page
            .getByRole('dialog')
            .filter({ has: running.page.getByRole('heading', { name: 'Settings' }) });
        await settingsDialog.locator('.archived-sessions-entry').click();
        // Opening the manager closes Settings first, so only one dialog remains.
        await expect(settingsDialog).toHaveCount(0);
        const dialog = running.page.getByRole('dialog');
        const archivedRow = dialog.locator('.archived-manager-row');
        await expect(archivedRow).toHaveCount(1);
        const archivedRowDeleteButton = archivedRow.getByRole('button', { name: /^Delete / });
        await expect(archivedRowDeleteButton).toBeVisible();

        // Cancel keeps the archived row.
        await stubMessageBoxResponse(running.app, 1);
        await archivedRowDeleteButton.click();
        await waitForMessageBoxCall(running.app);
        await expect(archivedRow).toHaveCount(1);

        // Confirm removes the archived row and the now-empty Archived group.
        await stubMessageBoxResponse(running.app, 0);
        await archivedRowDeleteButton.click();

        await expect(archivedRow).toHaveCount(0);
        await expect(dialog.getByText('No archived Sessions yet')).toBeVisible();
        await dialog.getByRole('button', { name: 'Done' }).click();
        await expect(dialog).toHaveCount(0);
        // Deleting the last archived Session clears the primarySidebar's per-Project archived badge.
        await expect(running.page.locator('.project-archived-count')).toHaveCount(0);
        const snapshot = await pageRequest<{ sessions: Array<{ id: string }> }>(
            running.page,
            'app.bootstrap',
        );
        expect(
            snapshot.sessions.find((session) => session.id === archivedSessionId),
        ).toBeUndefined();
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('primarySidebar omits Settings and Search while shortcuts and app menu keep both commands', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-primary-sidebar-entrypoints-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await expect(running.page.locator('.primary-sidebar-footer')).toHaveCount(0);
        await expect(running.page.getByRole('button', { name: 'Settings' })).toHaveCount(0);
        await expect(running.page.getByRole('button', { name: 'Search' })).toHaveCount(0);
        await expect(running.page.locator('.statusbar-toggle')).toHaveCount(0);

        await expect(running.page.locator('.session-primary-sidebar')).toBeVisible();
        await running.page.keyboard.press('Meta+[');
        await expect(running.page.locator('.session-primary-sidebar')).toHaveCount(0);
        await expect(running.page.locator('.collapsed-primary-sidebar-titlebar')).toBeVisible();
        await running.page.keyboard.press('Meta+[');
        await expect(running.page.locator('.session-primary-sidebar')).toBeVisible();

        await expect(running.page.locator('.secondary-sidebar')).toBeVisible();
        await running.page.keyboard.press('Meta+]');
        await expect(running.page.locator('.secondary-sidebar')).toHaveCount(0);
        await running.page.setViewportSize({ width: 800, height: 700 });
        await running.page.keyboard.press('Meta+]');
        await expect(running.page.locator('.secondary-sidebar')).toBeVisible();
        expect(
            await running.page.locator('.app-shell').evaluate((element) => ({
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
            })),
        ).toEqual({ clientWidth: 800, scrollWidth: 800 });

        await running.page.keyboard.press('Meta+,');
        const settings = running.page.getByRole('dialog');
        await expect(settings).toContainText('Settings');
        await settings.getByRole('button', { name: 'Close' }).click();
        await expect(settings).toHaveCount(0);
        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        const paletteSearch = running.page.getByPlaceholder(
            'Search projects, sessions, and commands…',
        );
        await expect(paletteSearch).toBeFocused();
        await expect(palette.getByRole('button', { name: 'Close' })).toHaveCount(0);
        await paletteSearch.fill('new terminal');
        const terminalCommand = palette.getByRole('option').filter({
            has: running.page.getByText('New Terminal', { exact: true }),
        });
        await expect(terminalCommand).toBeVisible();
        await expect(terminalCommand.locator('kbd')).toHaveText(['⌘', 'T']);
        await running.page.keyboard.press('Escape');
        await expect(palette).toHaveCount(0);

        const menuItems = await running.app.evaluate(({ Menu }) => {
            const menu = Menu.getApplicationMenu();
            return [
                'command.primarySidebar.toggle',
                'command.secondarySidebar.toggle',
                'command.settings.open',
                'command.commandPalette.open',
                'command.secondarySidebar.searchFiles',
                'command.workbench.closeActiveTab',
            ].map((id) => {
                const item = menu?.getMenuItemById(id);
                return item ? { accelerator: item.accelerator, id: item.id } : undefined;
            });
        });
        expect(menuItems).toEqual([
            { accelerator: 'Command+[', id: 'command.primarySidebar.toggle' },
            { accelerator: 'Command+]', id: 'command.secondarySidebar.toggle' },
            { accelerator: 'Command+,', id: 'command.settings.open' },
            { accelerator: 'Command+Shift+P', id: 'command.commandPalette.open' },
            { accelerator: 'Command+Shift+F', id: 'command.secondarySidebar.searchFiles' },
            { accelerator: 'Command+W', id: 'command.workbench.closeActiveTab' },
        ]);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
