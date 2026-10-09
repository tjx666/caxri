import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { publishFullScreenState } from './support/full-screen-state.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    openSettingsTab,
    pageRequest,
    pressNewTerminal,
    selectedSessionId,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';
import { dismissContextMenu, waitForContextMenu } from './support/native-context-menu.ts';

test('primarySidebar titlebar is logo-free, holds only history and the Activity toggle, and stays draggable', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-titlebar-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const titlebar = running.page.locator('.primary-sidebar-title');
        await expect(titlebar.locator('[data-caxri-logo]')).toHaveCount(0);
        // The Add Project entry points are the `Cmd+O` shortcut, the Project menu, and the command
        // palette; the titlebar carries exactly three controls: the Session history pair and the
        // Activity toggle that swaps the side bar's body, and every one of them opts out of the
        // drag region so a click acts instead of moving the window.
        await expect(titlebar.getByRole('button')).toHaveCount(3);
        await expect(titlebar.locator('[data-session-history="back"]')).toHaveCount(1);
        await expect(titlebar.locator('[data-session-history="forward"]')).toHaveCount(1);
        await expect(titlebar.locator('.primary-sidebar-activity-toggle')).toHaveCount(1);
        expect(
            await titlebar
                .locator('.session-history-navigation, .primary-sidebar-activity-toggle')
                .evaluateAll((elements) =>
                    elements.map((element) =>
                        getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                    ),
                ),
        ).toEqual(['no-drag', 'no-drag']);
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
        /**
         * At rest the invisible hover actions reserve no width, so the name's box runs to the heading's edge; hover
         * makes room for them instead.
         */
        const titleRightInset = () =>
            projectHeading.evaluate((heading) => {
                const select = heading.querySelector<HTMLElement>('.project-select');
                if (!select) throw new Error('Project title is unavailable');
                return heading.getBoundingClientRect().right - select.getBoundingClientRect().right;
            });
        await running.page.mouse.move(500, 300);
        expect(await titleRightInset()).toBeLessThanOrEqual(1);

        await projectTitle.hover();
        const projectCard = running.page.locator('.project-details-card');
        await expect(projectCard).toBeVisible();
        await expect(projectCard.getByRole('heading', { name: 'project' })).toBeVisible();
        await expect(projectCard.getByText('1 active Session', { exact: true })).toBeVisible();
        await expect(projectCard.getByText(canonicalRoot, { exact: true })).toBeVisible();

        await projectTitle.click({ button: 'right' });
        await waitForContextMenu(running.app);
        await expect(projectCard).not.toBeVisible();
        await dismissContextMenu(running.app);

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
        await expect(
            running.page.locator(`${VISIBLE_SESSION} .xterm-helper-textarea`),
        ).toBeFocused();

        // Delete is the keyboard equivalent of the per-row Archive button.
        // Archiving the focused row must not throw focus out of the tree: it lands on a neighbor
        // row. Target the *non-selected* second card so the selection stays put; archiving the
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
        // The heading names its Session count, so the accessible name is never the bare title.
        const projectName = projectHeading.getByRole('treeitem', { name: 'project (1 Session)' });
        await projectDisclosure.click();
        /**
         * The chevron is `tabIndex={-1}` and unknown to the tree's key handling, so a click that left focus on it
         * stranded the arrow keys. It hands focus to the heading's own treeitem instead, and the tree keys work from
         * there (issue #1012).
         */
        await expect(projectName).toBeFocused();
        const collapsedDisclosure = projectHeading.getByRole('button', {
            name: 'Expand project',
        });
        await expect(collapsedDisclosure.locator('svg')).toHaveClass(/lucide-chevron-right/);
        await expect(projectHeading.locator('.project-select .project-folder-icon')).toHaveClass(
            /lucide-folder-closed/,
        );
        await running.page.keyboard.press('ArrowRight');
        await expect(projectDisclosure.locator('svg')).toHaveClass(/lucide-chevron-down/);
        await projectDisclosure.click();
        await collapsedDisclosure.click();
        await expect(projectName).toBeFocused();
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
        const strip = running.page.locator(`${VISIBLE_SESSION} .work-tabs`);
        const tab = strip.locator('.work-tab').last();
        const actions = strip.locator('.tab-actions');
        // The single-tab bar floats its + over the tab's trailing end, quiet until the pointer or keyboard reaches
        // the bar. A second tab gives it a visible slot at rest.
        await expect(actions).toHaveCount(1);
        await expect(actions.locator(':scope > div')).toHaveCSS('opacity', '0');
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

        // A click or Enter on the tab-strip + clones the Session's live primary Agent Terminal (Fix #1292), but this
        // Session only ever grew shell Terminals (`pressNewTerminal` above, no Agent-mode fixture) and E2E configures
        // no `session.defaultAgent`, so there is nothing to clone or fall back to and the button still asks. Advertising
        // ⌘T here would also misstate the shortcut, which falls back to a plain shell rather than asking.
        const newTerminal = running.page.getByRole('button', { name: 'New Terminal' });
        await newTerminal.hover();
        await expect(newTerminal).not.toHaveAttribute('data-base-ui-tooltip-trigger');
        // Named after the hovered button: Base UI points the popup's `aria-labelledby` at its active trigger.
        const agentMenu = running.page.getByRole('menu', { name: 'New Terminal' });
        await expect(agentMenu).toBeVisible();
        const agents = ['Claude Code', 'Codex', 'Codex (Chat)', 'Grok Build', 'Shell'];
        await expect(agentMenu.getByRole('menuitem')).toHaveText(agents);
        await running.page.keyboard.press('Escape');
        await newTerminal.focus();
        await newTerminal.press('Enter');
        await expect(agentMenu).toBeVisible();
        await running.page.keyboard.press('Escape');
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

        const settingsTab = await openSettingsTab(running.page);
        await expect(settingsTab).toContainText('Settings');
        // Settings is a Workbench tab now, not a modal (issue caxri#1289): `Cmd+W` closes it
        // outright; there is no "Close" button to click anymore.
        await running.page.keyboard.press('Meta+w');
        await expect(settingsTab).toHaveCount(0);
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
