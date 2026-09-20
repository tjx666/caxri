import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

test('Project search opens name results and reveals grouped content matches', async () => {
    allowE2EErrors([
        { source: 'server-core', event: 'ipc.request_failed', code: 'VALIDATION', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-search-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const keybindingsPath = join(userData, 'config', 'keybindings.jsonc');
    await mkdir(join(userData, 'config'), { recursive: true });
    await writeFile(
        keybindingsPath,
        `[
  // Simulate the released Inspector default persisted by an existing profile.
  { "key": "cmd+o", "command": "project.create" },
  { "key": "cmd+shift+f", "command": "inspector.searchFiles" },
]
`,
        'utf8',
    );
    await execFileAsync('mkdir', [
        '-p',
        join(root, 'src'),
        join(root, 'docs'),
        join(root, 'node_modules'),
    ]);
    const source = Array.from({ length: 100 }, (_, index) =>
        index === 79 ? 'const MagicNeedle = Token;' : `const line${index + 1} = ${index + 1};`,
    ).join('\n');
    await Promise.all([
        writeFile(join(root, '000-pathological.txt'), `${'a'.repeat(48)}!\n`, 'utf8'),
        writeFile(join(root, 'src', 'target-name.ts'), source, 'utf8'),
        writeFile(join(root, 'src', 'target-name.test.ts'), 'MagicNeedle in test\n', 'utf8'),
        writeFile(join(root, 'docs', 'guide.md'), 'MagicNeedle in docs\n', 'utf8'),
        writeFile(join(root, 'node_modules', 'hidden.ts'), 'MagicNeedle hidden\n', 'utf8'),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await expect(
            running.page.getByRole('combobox', { name: 'Find Project files' }),
        ).toHaveCount(0);
        // `treeitem`, not `button`: file tree rows carry an explicit `role="treeitem"` that
        // overrides their implicit button role. This matters most for the `toHaveCount(0)` checks
        // further down, which would pass vacuously against the old role whether or not the tree
        // was on screen.
        await expect(
            running.page.getByRole('treeitem', { name: 'node_modules', exact: true }),
        ).toBeVisible();
        const settings = await pageRequest<{
            value: Record<string, unknown> & { 'files.exclude': Record<string, boolean> };
        }>(running.page, 'settings.get');
        const hiddenSource = `${JSON.stringify(
            {
                ...settings.value,
                'files.exclude': {
                    ...settings.value['files.exclude'],
                    '**/node_modules': true,
                },
            },
            null,
            2,
        )}\n`;
        await pageRequest(running.page, 'settings.update', { source: hiddenSource });
        await expect(
            running.page.getByRole('treeitem', { name: 'node_modules', exact: true }),
        ).toHaveCount(0);
        const visibleSource = `${JSON.stringify(
            {
                ...settings.value,
                'files.exclude': {
                    ...settings.value['files.exclude'],
                    '**/node_modules': false,
                },
            },
            null,
            2,
        )}\n`;
        await pageRequest(running.page, 'settings.update', { source: visibleSource });
        await expect(
            running.page.getByRole('treeitem', { name: 'node_modules', exact: true }),
        ).toBeVisible();

        await running.page.keyboard.press('Meta+Shift+F');
        const nameSearch = running.page.getByRole('combobox', { name: 'Find Project files' });
        await expect(nameSearch).toBeFocused();
        const migratedKeybindings = await readFile(keybindingsPath, 'utf8');
        expect(migratedKeybindings).toContain('"command": "secondarySidebar.searchFiles"');
        expect(migratedKeybindings).not.toContain('"command": "inspector.searchFiles"');
        await expect(running.page.locator('[data-search-mode-icon="name"]')).toBeVisible();
        await expect(running.page.getByRole('textbox', { name: 'Files to include' })).toHaveCount(
            0,
        );
        /*
         * The overlay leaves the Files view container alone: the tree stays mounted and visible behind it, which is the
         * behavior change this suite is here to pin. The inline panel used to replace the tree in the sidebar.
         *
         * Located by attribute rather than by role: a modal dialog takes the rest of the window out of the
         * accessibility tree, so while the overlay is open `getByRole('treeitem')` cannot see a row that is still
         * plainly on screen. That is correct modal behavior, and the claim here is about the pixels, not the roles.
         */
        await expect(
            running.page.locator('[role="treeitem"][aria-label="node_modules"]'),
        ).toBeVisible();
        const modeSegments = running.page.locator('.search-mode-segments');
        const [nameBounds, contentBounds, segmentBounds] = await Promise.all([
            running.page.getByRole('button', { name: 'Name', exact: true }).boundingBox(),
            running.page.getByRole('button', { name: 'Content', exact: true }).boundingBox(),
            modeSegments.boundingBox(),
        ]);
        expect(nameBounds).not.toBeNull();
        expect(contentBounds).not.toBeNull();
        expect(segmentBounds).not.toBeNull();
        expect(Math.abs(nameBounds!.width - contentBounds!.width)).toBeLessThanOrEqual(1);
        expect(nameBounds!.width + contentBounds!.width).toBeGreaterThan(segmentBounds!.width - 8);

        await nameSearch.fill('target-name');
        // Scoped to `.search-results`: the Files tree is still on screen behind the overlay, so the locator is pinned
        // to the overlay rather than to whatever the sidebar happens to be showing.
        const nameResult = running.page
            .locator('.search-results .search-result')
            .filter({ hasText: 'target-name.ts' });
        await expect(nameResult).toBeVisible();
        await expect(nameResult.locator('[data-file-icon="file_type_typescript"]')).toBeVisible();
        /*
         * The first result is selected without a keystroke and the input — not the row — keeps focus, which is what
         * `aria-activedescendant` exists to report. The preview pane opposite it is filled from that same selection.
         */
        await expect(nameSearch).toBeFocused();
        await expect(nameResult).toHaveAttribute('aria-selected', 'true');
        const activeDescendant = await nameSearch.getAttribute('aria-activedescendant');
        expect(activeDescendant).toBe(await nameResult.getAttribute('id'));
        await expect(
            running.page.locator('.search-preview [data-search-preview-line="1"]'),
        ).toContainText('const line1 = 1;');

        // Double click opens; a single click only moves the selection, so the tab must not exist before it.
        await nameResult.click();
        await expect(running.page.locator('.work-tab', { hasText: 'target-name.ts' })).toHaveCount(
            0,
        );
        await nameResult.dblclick();
        await expect(
            running.page.locator('.work-tab', { hasText: 'target-name.ts' }),
        ).toBeVisible();
        // Opening a result dismisses the overlay: the user asked to be somewhere else.
        await expect(nameSearch).toHaveCount(0);

        /*
         * The Files caption keeps three actions once Search leaves it. Asserted here rather than only in
         * `primary-sidebar-chrome.e2e.ts` because this is the suite that watches the overlay take the job over.
         */
        await expect(
            running.page.locator('.panel-caption').getByRole('button', { name: 'Search Files' }),
        ).toHaveCount(0);

        await running.page.keyboard.press('Meta+Shift+F');
        await running.page.getByRole('button', { name: 'Content', exact: true }).click();
        const contentSearch = running.page.getByRole('combobox', {
            name: 'Search Project contents',
        });
        await expect(running.page.locator('[data-search-mode-icon="content"]')).toBeVisible();
        await running.page.getByRole('textbox', { name: 'Files to include' }).fill('src/**');
        await running.page.getByRole('textbox', { name: 'Files to exclude' }).fill('*.test.ts');
        await contentSearch.fill('magicneedle');
        const sourceGroup = running.page.locator(
            '.search-result-group[title="src/target-name.ts"]',
        );
        await expect(sourceGroup).toBeVisible();
        await expect(sourceGroup.locator('[data-file-icon="file_type_typescript"]')).toBeVisible();
        await expect(running.page.locator('.search-results')).not.toContainText('docs/guide.md');
        await expect(running.page.locator('.search-results')).not.toContainText(
            'target-name.test.ts',
        );

        const matchCase = running.page.getByRole('button', { name: 'Match Case' });
        await matchCase.click();
        await expect(running.page.getByText('No results.')).toBeVisible();
        await matchCase.click();
        await expect(sourceGroup).toBeVisible();

        await contentSearch.fill('[');
        await running.page.getByRole('button', { name: 'Use Regular Expression' }).click();
        await expect(running.page.locator('.project-search [role="alert"]')).toContainText(
            'Search failed.',
        );
        await contentSearch.fill('MagicN[a-z]+');
        await expect(sourceGroup).toBeVisible();

        await contentSearch.fill('MagicNeedle');
        await running.page.getByRole('button', { name: 'Use Regular Expression' }).click();
        const contentResult = sourceGroup.getByRole('treeitem').filter({ hasText: '80' });
        await expect(contentResult).toContainText('const MagicNeedle = Token;');
        await expect(contentResult.locator('mark')).toHaveText('MagicNeedle');
        /*
         * The preview reads its context lines from `files.read` rather than from the search result, which only ever
         * carries the matching line. Lines 79 and 81 are the proof that it did.
         */
        await expect(
            running.page.locator('.search-preview [data-search-preview-match]'),
        ).toContainText('const MagicNeedle = Token;');
        await expect(
            running.page.locator('.search-preview [data-search-preview-line="79"]'),
        ).toContainText('const line79 = 79;');
        await expect(
            running.page.locator('.search-preview [data-search-preview-line="81"]'),
        ).toContainText('const line81 = 81;');

        // Enter opens whatever `aria-activedescendant` names, without the list ever taking focus.
        await contentSearch.press('Enter');
        await expect(running.page.locator('.line-numbers.active-line-number')).toHaveText('80');
        await expect(
            running.page.locator('.view-line').filter({ hasText: 'MagicNeedle' }),
        ).toBeVisible();

        await running.page.keyboard.press('Meta+Shift+F');
        const reopened = running.page.getByRole('combobox', { name: 'Find Project files' });
        await expect(reopened).toBeFocused();
        // A fresh open starts empty: the overlay mounts inside the Dialog's portal, which unmounts on close.
        await expect(reopened).toHaveValue('');
        await running.page.getByRole('button', { name: 'Content', exact: true }).click();
        const timedOut = running.page.getByRole('combobox', { name: 'Search Project contents' });
        await running.page
            .getByRole('textbox', { name: 'Files to include' })
            .fill('000-pathological.txt');
        await running.page.getByRole('button', { name: 'Use Regular Expression' }).click();
        await timedOut.fill('^(a|aa)+$');
        await expect(running.page.locator('.project-search [role="status"]')).toContainText(
            'Search timed out after scanning',
            { timeout: 10_000 },
        );
        await expect(running.page.getByText('No results.')).toHaveCount(0);

        await running.page.keyboard.press('Escape');
        await expect(
            running.page.getByRole('combobox', { name: 'Search Project contents' }),
        ).toHaveCount(0);
        await expect(
            running.page.getByRole('treeitem', { name: 'node_modules', exact: true }),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
