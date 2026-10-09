import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';
import {
    clickTerminalLink,
    createProjectSession,
    createShellSession,
    launchCaxri,
    typeTerminal,
} from './support/helpers.ts';

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

/**
 * Longer than the default `editor.foldOnOpenLineThreshold` of 1,000 lines. Every tenth entry is a three-line function,
 * so line 2 starts a foldable region whose body (line 3) is hidden once the file folds.
 */
function longTypeScript(): string {
    const body = Array.from({ length: 1_200 }, (_, index) =>
        index % 10 === 0
            ? `export function fn${index}() {\n    return ${index};\n}`
            : `// line ${index}`,
    );
    return `import { readFile } from 'node:fs/promises';\n${body.join('\n')}\n`;
}

/**
 * One root object whose first-level values are large nested objects, the shape of an assembled config file.
 */
function longJson(): string {
    const models = Object.fromEntries(
        Array.from({ length: 150 }, (_, index) => [
            `model-${index}`,
            { id: `model-${index}`, pricing: { input: index, output: index * 2 } },
        ]),
    );
    return `${JSON.stringify({ version: 3, models, defaults: { chat: 'model-1' } }, null, 2)}\n`;
}

/**
 * The line numbers Monaco currently renders inside the visible editor, top to bottom. A folded region's body is not
 * rendered, so its line numbers are absent.
 */
async function renderedLineNumbers(page: Page): Promise<number[]> {
    return page.locator('.monaco-editor').evaluate((editor) => {
        const bounds = editor.getBoundingClientRect();
        return [...editor.querySelectorAll<HTMLElement>('.line-numbers')]
            .map((element) => ({
                line: Number(element.textContent),
                top: element.getBoundingClientRect().top,
            }))
            .filter(
                ({ line, top }) =>
                    Number.isSafeInteger(line) && top >= bounds.top && top < bounds.bottom,
            )
            .toSorted((left, right) => left.top - right.top)
            .map(({ line }) => line);
    });
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

test('Long files fold on first open: code to its declarations, JSON to its top-level keys', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-fold-on-open-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await Promise.all([
        writeFile(join(root, 'long.ts'), longTypeScript(), 'utf8'),
        writeFile(join(root, 'jump.ts'), longTypeScript(), 'utf8'),
        writeFile(join(root, 'config.json'), longJson(), 'utf8'),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);

        /**
         * An Agent listing files as `path:1` opens them with the whole first line selected. No region can hide line 1,
         * so the file still opens as its outline, scrolled to the top.
         */
        await typeTerminal(running.page, String.raw`printf '%s\n' 'long.ts:1' 'jump.ts:495'`);
        await expect(running.page.locator('.xterm-rows')).toContainText('jump.ts:495');
        await clickTerminalLink(running.page, 'long.ts:1');
        await expect(running.page.getByRole('tab', { name: 'long.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect
            .poll(async () => (await renderedLineNumbers(running.page)).slice(0, 4))
            .toEqual([1, 2, 4, 5]);

        /**
         * A jump below line 1 is left unfolded: folding would pull the caret out of the hidden region it targeted.
         */
        await running.page.getByRole('tab', { name: 'Shell' }).click();
        await clickTerminalLink(running.page, 'jump.ts:495');
        await expect(running.page.getByRole('tab', { name: 'jump.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        // Line 495 is a function body; the next function's body (line 507) stays visible too.
        await expect
            .poll(() => renderedLineNumbers(running.page))
            .toEqual(expect.arrayContaining([495, 507]));

        await running.page
            .locator('.file-list')
            .first()
            .getByRole('treeitem', { name: 'config.json', exact: true })
            .click();
        await expect(running.page.getByRole('tab', { name: 'config.json' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        // The root stays open while `"models": {` (line 3) collapses over its 150 entries, so the next rendered line
        // is the `"defaults"` key near the end of the file.
        await expect
            .poll(async () => {
                const [first, second, third, fourth = 0] = await renderedLineNumbers(running.page);
                return { open: [first, second, third], nextKeyAfterModels: fourth > 1_000 };
            })
            .toEqual({ open: [1, 2, 3], nextKeyAfterModels: true });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
