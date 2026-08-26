import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

test('Status Bar switches the primary branch and shows changed line counts', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-statusbar-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'status-project');
    const bin = join(testDirectory, 'bin');
    const gh = join(bin, 'gh');
    const loginShell = join(testDirectory, 'login-shell');
    const ghCalls = join(testDirectory, 'gh-calls');
    await execFileAsync('mkdir', ['-p', root, bin]);
    await writeFile(
        gh,
        `#!/bin/sh\nprintf 'call\\n' >> '${ghCalls}'\nprintf '%s' '{"number":11,"title":"Linked Status Bar","url":"https://github.com/tjx666/status-project/pull/11"}'\n`,
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
    await execFileAsync('git', ['init', '-b', 'feature/status-bar'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/tjx666/status-project.git'],
        { cwd: root },
    );
    await writeFile(join(root, 'tracked.txt'), 'before\n', 'utf8');
    await writeFile(join(root, 'source.ts'), 'const first = 1;\nconst second = 2;\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt', 'source.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await execFileAsync('git', ['branch', 'feature/local-picker'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'after\nadded\n', 'utf8');

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: '/usr/bin:/bin', SHELL: loginShell },
    });
    try {
        await createProjectSession(running.page);
        await expect(running.page.locator('.statusbar-count')).toHaveCount(0);
        await expect(running.page.locator('.statusbar-toggle')).toHaveCount(0);
        await expect(
            running.page.getByLabel(/^Open Process Explorer — Terminal memory: [\d.]+ MB$/),
        ).toBeVisible();
        const childProcesses = running.page.getByLabel(
            /^Open Process Explorer — Terminal: \d+ child processes?$/,
        );
        await expect(childProcesses).toBeVisible();
        await expect(childProcesses).toHaveText(/^\d+$/);
        // The status bar renders a bare count, so the explanation has to reach sighted mouse users
        // too, not just the accessible name. It moved off the native `title` attribute onto the
        // shared `Tooltip` primitive, so assert the popup actually renders rather than that an
        // attribute exists — a `title` can be present and still never be shown.
        await childProcesses.hover();
        await expect(running.page.locator('.tooltip-popup')).toHaveText(
            /^Open Process Explorer — Terminal: \d+ child processes?$/,
        );
        // The status bar sits at the window's bottom edge, so the popup flips above its trigger and
        // covers the neighbouring status items. Park the pointer away and wait for the close
        // animation to finish before the branch picker below is clicked.
        await running.page.mouse.move(0, 0);
        await expect(running.page.locator('.tooltip-popup')).toHaveCount(0);
        // With a Session selected, the standalone "Open project files" chip no longer renders:
        // the Workbench Root picker owns the project identity (title only — the branch next door
        // already names the branch, so the trigger must not repeat it).
        const project = running.page.getByRole('combobox', {
            name: /^Switch Workbench Root from status-project/,
        });
        const branch = running.page.getByRole('combobox', {
            name: 'Switch branch from feature/status-bar',
        });
        const pullRequest = running.page.getByRole('link', {
            name: 'Open pull request #11',
        });
        const changes = running.page.getByRole('button', {
            name: 'Open changes: 2 additions, 1 deletion',
        });
        await expect(project).toHaveText('status-project');
        await expect(
            running.page.getByRole('button', { name: 'Open project files: status-project' }),
        ).toHaveCount(0);
        await expect(branch).toHaveText('feature/status-bar');
        await expect(pullRequest).toHaveAttribute(
            'href',
            'https://github.com/tjx666/status-project/pull/11',
        );
        await expect(changes).toHaveText('+2 -1');
        const [projectColor, branchColor, changesColor] = await Promise.all(
            [project, branch, changes].map((item) =>
                item.evaluate((element) => getComputedStyle(element).color),
            ),
        );
        expect([projectColor, branchColor, changesColor]).toEqual([
            branchColor,
            branchColor,
            branchColor,
        ]);

        await branch.click();
        // The option's accessible name carries a relative-time affix (e.g. "feature/local-picker
        // 5 seconds ago") since the picker sorts by commit recency, so match on the prefix.
        await running.page.getByRole('option', { name: /^feature\/local-picker / }).click();
        await expect(
            running.page.getByRole('combobox', {
                name: 'Switch branch from feature/local-picker',
            }),
        ).toBeVisible();
        await expect
            .poll(async () => {
                const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
                    cwd: root,
                });
                return stdout.trim();
            })
            .toBe('feature/local-picker');

        await running.page.keyboard.press('Meta+]');
        await changes.click();
        await expect(running.page.locator('.secondary-sidebar')).toBeVisible();
        /**
         * The View chrome intentionally repeats the title in the tab and panel caption.
         */
        await expect(running.page.getByRole('tab', { name: 'Git', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );

        await writeFile(join(root, 'untracked.txt'), 'new\n', 'utf8');
        await expect(
            running.page.getByRole('button', {
                name: 'Open changes: 2 additions, 1 deletion',
            }),
        ).toBeVisible();
        expect((await readFile(ghCalls, 'utf8')).trim().split('\n')).toHaveLength(2);

        // The status bar no longer offers an "open Files" chip, so reach the file tree through
        // the secondarySidebar's own Files tab (the secondarySidebar is already open from `changes.click()`).
        await running.page.getByRole('tab', { name: 'Files', exact: true }).click();
        await running.page.getByRole('treeitem', { name: 'source.ts', exact: true }).click();
        await expect(
            running.page.getByRole('button', { name: /^Open Process Explorer — Terminal/ }),
        ).toHaveCount(0);
        await expect(running.page.getByLabel('File type: TypeScript')).toBeVisible();
        await expect(running.page.getByLabel(/^Editor position: Ln 1, Col 1/)).toBeVisible();
        await expect(running.page.getByLabel(/^Git blame: Caxri E2E, .+, initial$/)).toBeVisible();
        // The GitLens-style file annotation above the editor reports the file's latest commit.
        await expect(running.page.locator('.editor-head-blame')).toContainText(
            /Caxri E2E, .+ · initial/,
        );
        const editor = running.page.locator('.monaco-editor');
        await editor.click({ position: { x: 80, y: 12 } });
        await running.page.keyboard.press('Shift+ArrowRight');
        await expect(running.page.getByLabel(/1 characters selected/)).toBeVisible();
        await running.page.keyboard.type('x');
        await running.page.keyboard.press('Meta+S');
        await expect(
            running.page.getByLabel('Git blame: uncommitted changes on line 1'),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
