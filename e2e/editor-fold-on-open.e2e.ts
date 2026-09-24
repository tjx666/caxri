import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

/**
 * Fold All waits for Monaco's folding model. A returning tab first paints expanded even when a later Fold All will undo
 * the user's choice, so observe the real editor through that delayed action rather than taking one early sample.
 */
async function expectNoDelayedRefold(page: Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve, reject) => {
                const editor = document.querySelector('.monaco-editor');
                if (!editor) {
                    reject(new Error('Monaco Editor is unavailable'));
                    return;
                }
                const timer: { id?: ReturnType<typeof setTimeout> } = {};
                const observer = new MutationObserver(() => {
                    if (!editor.querySelector('.inline-folded')) return;
                    observer.disconnect();
                    if (timer.id !== undefined) clearTimeout(timer.id);
                    reject(new Error('The returning Editor refolded the long file'));
                });
                timer.id = setTimeout(() => {
                    observer.disconnect();
                    resolve();
                }, 2_000);
                observer.observe(editor, { attributes: true, childList: true, subtree: true });
                if (editor.querySelector('.inline-folded')) {
                    observer.disconnect();
                    clearTimeout(timer.id);
                    reject(new Error('The returning Editor was already folded'));
                }
            }),
    );
}

test('a long Editor file keeps the user’s unfolded regions after a tab switch', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-fold-state-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root);
    const longSource = `${Array.from({ length: 4 }, (_, section) =>
        [
            `function section${section}() {`,
            ...Array.from({ length: 300 }, (_, line) => `    const value${line} = ${line};`),
            '}',
        ].join('\n'),
    ).join('\n')}\n`;
    await writeFile(join(root, 'long.ts'), longSource, 'utf8');
    await writeFile(join(root, 'short.ts'), 'function short() {\n    return true;\n}\n', 'utf8');

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        await page.getByRole('treeitem', { name: 'long.ts', exact: true }).click();
        const editor = page.locator('.monaco-editor');
        const folded = editor.locator('.inline-folded');
        await expect(folded.first()).toBeVisible();
        const longTab = page.locator('.work-tab', { hasText: 'long.ts' });
        await longTab.getByRole('tab').dblclick();
        await expect(longTab).not.toHaveAttribute('data-preview');

        await editor.click({ position: { x: 120, y: 24 } });
        await page.keyboard.press('Meta+k');
        await page.keyboard.press('Meta+j');
        await expect(folded).toHaveCount(0);
        await page.keyboard.press('Meta+ArrowUp');
        await expect(page.getByLabel(/^Editor position: Ln 1, Col 1/)).toBeVisible();

        await page.getByRole('treeitem', { name: 'short.ts', exact: true }).click();
        await expect(editor.locator('.codicon-folding-expanded')).toHaveCount(1);
        await expect(folded).toHaveCount(0);
        await longTab.getByRole('tab').click();
        await expect(folded).toHaveCount(0);
        await expectNoDelayedRefold(page);

        await editor.click({ position: { x: 120, y: 24 } });
        await page.keyboard.press('PageDown');
        const position = page.locator('.statusbar-selection');
        await expect(position).not.toHaveAttribute('aria-label', /^Editor position: Ln 1, /);
        const rememberedPosition = await position.getAttribute('aria-label');
        expect(rememberedPosition).toMatch(/^Editor position: Ln \d+, Col \d+/);
        await page.getByRole('treeitem', { name: 'short.ts', exact: true }).click();
        await longTab.getByRole('tab').click();
        await expect(position).toHaveAttribute('aria-label', rememberedPosition!);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
