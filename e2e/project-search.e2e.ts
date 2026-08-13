import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { allowE2EErrors, expect, test } from './fixtures.ts';

import { createProjectSession, launchCaxri, pageRequest } from './helpers.ts';

const execFileAsync = promisify(execFile);

test('Project search opens name results and reveals grouped content matches', async () => {
    allowE2EErrors([
        { source: 'main', event: 'ipc.request_failed', code: 'VALIDATION', count: 1 },
        { source: 'runtime', event: 'ipc.request_failed', code: 'VALIDATION', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-search-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
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
        writeFile(join(root, 'src', 'target-name.ts'), source, 'utf8'),
        writeFile(join(root, 'src', 'target-name.test.ts'), 'MagicNeedle in test\n', 'utf8'),
        writeFile(join(root, 'docs', 'guide.md'), 'MagicNeedle in docs\n', 'utf8'),
        writeFile(join(root, 'node_modules', 'hidden.ts'), 'MagicNeedle hidden\n', 'utf8'),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await expect(running.page.getByRole('textbox', { name: 'Find Project files' })).toHaveCount(
            0,
        );
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
        const fileCaption = running.page.locator('.panel-caption');
        const searchButton = fileCaption.getByRole('button', { name: 'Search Files' });
        await running.page.keyboard.press('Meta+Shift+F');
        const nameSearch = running.page.getByRole('textbox', { name: 'Find Project files' });
        const modeSegments = running.page.locator('.search-mode-segments');
        await expect(nameSearch).toBeFocused();
        await expect(running.page.locator('[data-search-mode-icon="name"]')).toBeVisible();
        await expect(running.page.getByRole('textbox', { name: 'Files to include' })).toHaveCount(
            0,
        );
        await expect(running.page.locator('.file-list')).toHaveCount(0);
        await expect(
            running.page.getByRole('treeitem', { name: 'node_modules', exact: true }),
        ).toHaveCount(0);
        await running.page.mouse.move(600, 300);
        await expect(searchButton).toHaveAttribute('aria-pressed', 'true');
        await expect(searchButton).toHaveCSS('opacity', '1');
        await expect(searchButton).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
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
        const nameResult = running.page
            .locator('.search-result')
            .filter({ hasText: 'target-name.ts' });
        await expect(
            running.page.locator('.search-tree-folder').filter({ hasText: 'src' }).first(),
        ).toBeVisible();
        await expect(nameResult.locator('[data-file-icon="typescript"]')).toBeVisible();
        await expect(nameResult).toBeVisible();
        await nameResult.click();
        await expect(
            running.page.locator('.work-tab', { hasText: 'target-name.ts' }),
        ).toBeVisible();

        await running.page.getByRole('button', { name: 'Content', exact: true }).click();
        const contentSearch = running.page.getByRole('textbox', {
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
        await expect(sourceGroup.locator('[data-file-icon="typescript"]')).toBeVisible();
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
        const contentResult = sourceGroup.locator('.search-result').filter({ hasText: '80' });
        await expect(contentResult).toContainText('const MagicNeedle = Token;');
        await expect(contentResult.locator('mark')).toHaveText('MagicNeedle');
        await contentResult.click();
        await expect(running.page.locator('.line-numbers.active-line-number')).toHaveText('80');
        await expect(
            running.page.locator('.view-line').filter({ hasText: 'MagicNeedle' }),
        ).toBeVisible();
        await running.page.keyboard.press('Meta+Shift+F');
        await expect(contentSearch).toBeFocused();
        await searchButton.click();
        await expect(
            running.page.getByRole('textbox', { name: 'Search Project contents' }),
        ).toHaveCount(0);
        await expect(
            running.page.getByRole('treeitem', { name: 'node_modules', exact: true }),
        ).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
