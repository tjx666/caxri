import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import type { Locator } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

/**
 * Held constant across every capture so width is the only variable between the snapshots.
 */
const WINDOW_HEIGHT = 900;

interface WidthCapture {
    /**
     * Snapshot file suffix: `status-bar-<name>.png`.
     */
    name: 'wide' | 'narrow';
    /**
     * Emulated viewport width.
     */
    width: number;
}

/**
 * The bar drops whole chips by measured width, lowest priority first (`chip-priority.ts`), so the spec asserts that
 * contract rather than fixed breakpoints:
 *
 * - `wide` has room for everything, so every chip renders.
 * - `narrow` leaves room for the never-hidden items and less than one droppable chip, so at least the child-process count
 *   has to go. It is derived from the wide bar instead of fixed, because the never-hidden set depends on the host: the
 *   debugging disclosure is always there under E2E, and a host without WebGL adds the Terminal's `Software` renderer
 *   chip, which a fixed 656px window cannot fit next to the fixture's long Project and branch names.
 * - At both widths no item's label is truncated, nothing overflows its region, and any chip still shown outranks every
 *   chip already dropped.
 */
const WIDE_WIDTH = 1_280;

/**
 * Room the narrow capture leaves beyond the never-hidden items: enough to absorb sub-pixel rounding, less than any
 * chip.
 */
const NARROW_SLACK = 4;

const PROJECT_NAME = 'width-project-with-a-deliberately-long-folder-name';
const BRANCH_NAME = 'feat/width-with-a-deliberately-long-branch-name';

/**
 * A dropped chip stays mounted, invisible and off screen, so the bar can keep measuring it; dropped means hidden.
 */
async function expectChip(chip: Locator, isVisible: boolean): Promise<void> {
    if (isVisible) await expect(chip).toBeVisible();
    else await expect(chip).toBeHidden();
}

test('Status Bar drops the lowest-priority chips as the window narrows', async () => {
    /**
     * Opt-in evidence: the assertions below are the contract, the PNGs are the before/after parity record a refactor is
     * compared against, so they are only written when a caller asks for them.
     */
    const snapshotDirectory = process.env.CAXRI_STATUSBAR_SNAPSHOT_DIR;
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-statusbar-width-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, PROJECT_NAME);
    const bin = join(testDirectory, 'bin');
    const gh = join(bin, 'gh');
    const loginShell = join(testDirectory, 'login-shell');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(bin, { recursive: true }),
        snapshotDirectory ? mkdir(snapshotDirectory, { recursive: true }) : undefined,
    ]);
    /**
     * The pull request is one of the droppable chips, so the fixed state has to own one. The stub answers the Server's
     * GraphQL-budget probe, the unbilled `rateLimit` self-query, with a realistic payload first, otherwise the Server
     * re-probes on every request. Matched on its `-f` flag so the branch-publication query, also `gh api graphql` but
     * with `--hostname`, is not mistaken for it.
     */
    await writeFile(
        gh,
        `#!/bin/sh
if [ "$1 $2 $3" = "api graphql -f" ]; then
  printf '%s' '{"data":{"rateLimit":{"limit":5000,"remaining":5000,"used":0,"resetAt":"2100-01-01T00:00:00Z"}}}'
  exit 0
fi
if [ "$1 $2" = "pr list" ]; then
  printf '%s' '[{"number":11,"state":"OPEN","isDraft":false}]'
  exit 0
fi
printf '%s' '{"number":11,"state":"OPEN","title":"Status Bar width parity","url":"https://github.com/tjx666/width-project/pull/11"}'
`,
        'utf8',
    );
    await chmod(gh, 0o755);
    await writeFile(
        loginShell,
        `#!/bin/sh
if [ "$1" = "-lic" ]; then
  printf '\n__CAXRI_LOGIN_PATH__${bin}:/usr/bin:/bin\n'
  exit 0
fi
exec /bin/zsh -l
`,
        'utf8',
    );
    await chmod(loginShell, 0o755);
    await execFileAsync('git', ['init', '-b', BRANCH_NAME], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/tjx666/width-project.git'],
        { cwd: root },
    );
    await writeFile(join(root, 'tracked.txt'), 'before\n', 'utf8');
    await writeFile(join(root, 'source.ts'), 'const first = 1;\nconst second = 2;\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt', 'source.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    // Gives the changed-lines chip a fixed "+2 -1" instead of a value that depends on scratch state.
    await writeFile(join(root, 'tracked.txt'), 'after\nadded\n', 'utf8');

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: '/usr/bin:/bin', SHELL: loginShell },
    });
    try {
        await createProjectSession(running.page);
        /**
         * A fresh profile starts on the built-in dark Dracula preset, so the snapshots do not depend on the host's
         * appearance setting; assert it rather than trust it.
         */
        await expect
            .poll(
                async () =>
                    (await pageRequest<{ value: { id: string } }>(running.page, 'theme.get')).value
                        .id,
            )
            .toBe('dracula');
        await running.page.setViewportSize({
            width: WIDE_WIDTH,
            height: WINDOW_HEIGHT,
        });

        const statusbar = running.page.locator('.statusbar');
        const project = running.page.getByRole('combobox', {
            name: new RegExp(`^Switch Workbench Root from ${PROJECT_NAME}`),
        });
        const branch = running.page.getByRole('combobox', {
            name: `Switch branch from ${BRANCH_NAME}`,
        });
        const pullRequest = running.page.getByRole('link', { name: 'Open pull request #11' });
        const changes = running.page.getByRole('button', {
            name: 'Open changes: 2 lines added, 1 removed',
        });
        await expect(project).toHaveText(PROJECT_NAME);
        await expect(branch).toHaveText(BRANCH_NAME);
        await expect(pullRequest).toBeVisible();
        await expect(changes).toHaveText('+2 -1');

        /**
         * `ActiveFileStatus` and `ActiveTerminalStatus` are mutually exclusive: `StatusBar` picks one from the active
         * pane tab's kind, so the editor state is proven here, once, and the width sweep below then runs on the
         * Terminal tab, the only state in which the width-sensitive chips exist at all.
         */
        const fileList = running.page.locator('.file-list').first();
        await fileList.getByRole('treeitem', { name: 'source.ts', exact: true }).click();
        await expect(running.page.getByLabel('File type: TypeScript')).toBeVisible();
        await expect(running.page.getByLabel(/^Editor position: Ln 1, Col 1/)).toBeVisible();
        await expect(running.page.getByLabel(/^Open Process Explorer — Terminal/)).toHaveCount(0);
        /**
         * The status bar spans every column of the `app-shell` grid, so its width is the shell's, not the window's.
         * With both sidebars open `clampLayoutToViewport`'s minimums floor that shell at 180 + 6 + 320 + 6 + 240 =
         * 752px (`stores/chrome-layout.ts`), wider than the narrow capture: the bar simply overflows a narrower window
         * instead of shrinking. Closing the SecondarySidebar is the ordinary ⌘] state that lets the shell actually
         * reach the widths under test.
         */
        await running.page.keyboard.press('Meta+]');
        await expect(running.page.locator('.secondary-sidebar')).toHaveCount(0);
        // Park the pointer so no hover or delayed tooltip is baked into a snapshot.
        await running.page.mouse.move(0, 0);
        await expect(running.page.locator('.tooltip-popup')).toHaveCount(0);
        if (snapshotDirectory) {
            await statusbar.screenshot({
                animations: 'disabled',
                path: join(snapshotDirectory, 'status-bar-wide-active-file.png'),
            });
        }

        await running.page.locator('.work-tab[data-terminal-id]').getByRole('tab').click();
        await running.page.mouse.move(0, 0);
        await expect(running.page.locator('.tooltip-popup')).toHaveCount(0);
        const memory = running.page.getByLabel(
            /^Open Process Explorer — Terminal memory: [\d.]+ MB$/,
        );
        const childProcesses = running.page.getByLabel(
            /^Open Process Explorer — Terminal: \d+ child processes?$/,
        );
        // Both readings arrive from a poll after the Terminal exists, so wait for the fully populated bar once.
        await expect(memory).toBeVisible();
        await expect(childProcesses).toBeVisible();
        await expect(running.page.getByLabel('File type: TypeScript')).toHaveCount(0);

        /**
         * Lowest priority first, mirroring `CHIP_DROP_ORDER`: a chip may only be shown while every chip after it is.
         */
        const dropOrder = [childProcesses, memory, pullRequest];
        const captureWidth = async (capture: WidthCapture): Promise<void> => {
            await running.page.setViewportSize({ width: capture.width, height: WINDOW_HEIGHT });
            if (capture.name === 'wide') {
                for (const chip of dropOrder) {
                    // eslint-disable-next-line no-await-in-loop -- each chip is asserted in turn on the settled bar.
                    await expectChip(chip, true);
                }
            } else {
                await expectChip(childProcesses, false);
            }
            const shown = await Promise.all(dropOrder.map(async (chip) => chip.isVisible()));
            for (const [index, isShown] of shown.entries())
                if (isShown) expect(shown.slice(index + 1).every(Boolean)).toBe(true);
            // Never dropped: the Project, branch, and change counter have no other home in the bar.
            await expect(project).toBeVisible();
            await expect(branch).toBeVisible();
            await expect(changes).toBeVisible();
            const layout = await statusbar.evaluate((element) => {
                const items = [
                    ...element.querySelectorAll<HTMLElement>(
                        ':scope .statusbar-item:not([role="combobox"]) > span, :scope .statusbar-info > span',
                    ),
                ];
                const regions = [
                    ...element.querySelectorAll<HTMLElement>(
                        '.statusbar-context, .statusbar-actions',
                    ),
                ];
                return {
                    truncated: items
                        .filter((label) => label.scrollWidth > label.clientWidth + 1)
                        .map((label) => label.textContent),
                    overflowing: regions
                        .filter((region) => region.scrollWidth > region.clientWidth + 1)
                        .map((region) => region.className),
                };
            });
            expect(layout).toEqual({ truncated: [], overflowing: [] });
            if (!snapshotDirectory) return;
            await statusbar.screenshot({
                animations: 'disabled',
                path: join(snapshotDirectory, `status-bar-${capture.name}.png`),
            });
            await running.page.screenshot({
                animations: 'disabled',
                path: join(snapshotDirectory, `window-${capture.width}.png`),
            });
        };

        await captureWidth({ name: 'wide', width: WIDE_WIDTH });
        // The width the bar needs once every droppable chip is gone, read from the settled wide bar.
        const neverHiddenSurplus = await statusbar.evaluate((element) => {
            const pixels = (value: string) => Number(value.replace(/px$/u, '')) || 0;
            const style = getComputedStyle(element);
            const gap = (node: Element) => pixels(getComputedStyle(node).columnGap);
            const available =
                element.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
            const regions = [...element.children];
            let required = gap(element) * Math.max(0, regions.length - 1);
            for (const region of regions) required += region.scrollWidth;
            for (const slot of element.querySelectorAll<HTMLElement>('[data-status-chip]')) {
                const width = slot.getBoundingClientRect().width;
                if (width > 0)
                    required -= width + (slot.parentElement ? gap(slot.parentElement) : 0);
            }
            return available - required;
        });
        await captureWidth({
            name: 'narrow',
            width: Math.ceil(WIDE_WIDTH - neverHiddenSurplus + NARROW_SLACK),
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
