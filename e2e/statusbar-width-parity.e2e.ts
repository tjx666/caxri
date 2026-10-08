import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import type { Locator } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

/**
 * Held constant across every capture so width is the only variable between the three snapshots.
 */
const WINDOW_HEIGHT = 900;

interface WidthCapture {
    /**
     * Snapshot file suffix: `status-bar-<name>.png`.
     */
    name: 'wide' | 'medium' | 'narrow';
    /**
     * Emulated viewport width.
     */
    width: number;
    /**
     * Footer width the Renderer resolves at `width`; asserted so a padding or quantization change fails loudly here
     * instead of silently moving a capture into the neighbouring band.
     */
    measuredWidth: number;
    showChildProcessCount: boolean;
    showMemory: boolean;
}

/**
 * Derived from `CHIP_PRIORITY_BREAKPOINTS` in `apps/desktop/src/renderer/src/features/status-bar/chip-priority.ts`:
 * child-process count 752, memory 680, pull request 610.
 *
 * Those thresholds are compared against the footer's _content-box_ width quantized down to a multiple of 8
 * (`useContainerWidth`), and the footer carries `px-2` (8px per side), so the number the Renderer resolves is
 * `floor((viewport - 16) / 8) * 8`, not the viewport width. Each width below therefore sits at least 16px clear of the
 * nearest breakpoint _after_ that conversion, so a small padding or scrollbar change cannot silently flip a chip:
 *
 * - 852 -> 832: above 752, every chip renders.
 * - 716 -> 696: below 752 and above 680, so only the child-process count is dropped.
 * - 656 -> 640: below 680 and above 610, so memory goes too while the pull request stays.
 *
 * The numbers are restated rather than imported from the Renderer on purpose: this spec must keep asserting the shipped
 * behavior across a Renderer-internal file move, and an import of the same constant the component uses would make the
 * assertion a tautology.
 */
const WIDTH_CAPTURES: readonly WidthCapture[] = [
    { name: 'wide', width: 852, measuredWidth: 832, showChildProcessCount: true, showMemory: true },
    {
        name: 'medium',
        width: 716,
        measuredWidth: 696,
        showChildProcessCount: false,
        showMemory: true,
    },
    {
        name: 'narrow',
        width: 656,
        measuredWidth: 640,
        showChildProcessCount: false,
        showMemory: false,
    },
];

async function expectChip(chip: Locator, isVisible: boolean): Promise<void> {
    if (isVisible) await expect(chip).toBeVisible();
    else await expect(chip).toHaveCount(0);
}

test('Status Bar drops the lowest-priority chips as the window narrows', async () => {
    /**
     * Opt-in evidence: the assertions below are the contract, the PNGs are the before/after parity record a refactor is
     * compared against, so they are only written when a caller asks for them.
     */
    const snapshotDirectory = process.env.CAXRI_STATUSBAR_SNAPSHOT_DIR;
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-statusbar-width-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'width-project');
    const bin = join(testDirectory, 'bin');
    const gh = join(bin, 'gh');
    const loginShell = join(testDirectory, 'login-shell');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(bin, { recursive: true }),
        snapshotDirectory ? mkdir(snapshotDirectory, { recursive: true }) : undefined,
    ]);
    /**
     * The pull request is one of the three priority chips, so the fixed state has to own one. The stub answers the
     * Server's GraphQL-budget probe, the unbilled `rateLimit` self-query, with a realistic payload first, otherwise the
     * Server re-probes on every request. Matched on its `-f` flag so the branch-publication query, also `gh api
     * graphql` but with `--hostname`, is not mistaken for it.
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
    await execFileAsync('git', ['init', '-b', 'feat/width'], { cwd: root });
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
            width: WIDTH_CAPTURES[0].width,
            height: WINDOW_HEIGHT,
        });

        const statusbar = running.page.locator('.statusbar');
        const project = running.page.getByRole('combobox', {
            name: /^Switch Workbench Root from width-project/,
        });
        const branch = running.page.getByRole('combobox', {
            name: 'Switch branch from feat/width',
        });
        const pullRequest = running.page.getByRole('link', { name: 'Open pull request #11' });
        const changes = running.page.getByRole('button', {
            name: 'Open changes: 2 lines added, 1 removed',
        });
        await expect(project).toHaveText('width-project');
        await expect(branch).toHaveText('feat/width');
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
        await expect(running.page.getByLabel(/^Open Process Explorer, Terminal/)).toHaveCount(0);
        /**
         * The status bar spans every column of the `app-shell` grid, so its width is the shell's, not the window's.
         * With both sidebars open `clampLayoutToViewport`'s minimums floor that shell at 180 + 6 + 320 + 6 + 240 =
         * 752px (`stores/chrome-layout.ts`), which is above two of the three breakpoints: the bar simply overflows a
         * narrower window instead of shrinking. Closing the SecondarySidebar is the ordinary ⌘] state that lets the
         * shell actually reach the widths under test.
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
            /^Open Process Explorer, Terminal memory: [\d.]+ MB$/,
        );
        const childProcesses = running.page.getByLabel(
            /^Open Process Explorer, Terminal: \d+ child processes?$/,
        );
        // Both readings arrive from a poll after the Terminal exists, so wait for the fully populated bar once.
        await expect(memory).toBeVisible();
        await expect(childProcesses).toBeVisible();
        await expect(running.page.getByLabel('File type: TypeScript')).toHaveCount(0);

        const captureWidth = async (capture: WidthCapture): Promise<void> => {
            await running.page.setViewportSize({ width: capture.width, height: WINDOW_HEIGHT });
            await expect
                .poll(() =>
                    statusbar.evaluate((element) => {
                        const style = getComputedStyle(element);
                        const content =
                            element.clientWidth -
                            Number(style.paddingLeft.replace('px', '')) -
                            Number(style.paddingRight.replace('px', ''));
                        // Mirrors `useContainerWidth`'s 8px quantization, which is the number the breakpoints see.
                        return Math.floor(content / 8) * 8;
                    }),
                )
                .toBe(capture.measuredWidth);
            await expectChip(memory, capture.showMemory);
            await expectChip(childProcesses, capture.showChildProcessCount);
            // Never dropped above 610px: the narrow capture must still prove which chips survived.
            await expect(pullRequest).toBeVisible();
            await expect(project).toBeVisible();
            await expect(branch).toBeVisible();
            await expect(changes).toBeVisible();
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

        for (const capture of WIDTH_CAPTURES) {
            // eslint-disable-next-line no-await-in-loop -- each width must settle and be captured before the next resize.
            await captureWidth(capture);
        }
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
