import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

test('editor folding chords, app chords, and Find controls remain available', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-find-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await writeFile(
        join(root, 'searchable.ts'),
        'function sample() {\n    const needle = true;\n    return needle;\n}\n',
        'utf8',
    );

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: 'searchable.ts', exact: true }).click();
        const editor = running.page.locator('.monaco-editor').first();
        await expect(editor).toBeVisible();

        await editor.click({ position: { x: 120, y: 24 } });
        const folded = editor.locator('.inline-folded');
        await expect(editor.locator('.codicon-folding-expanded')).toHaveCount(1);
        await running.page.keyboard.press('Meta+k');
        await running.page.keyboard.press('Meta+0');
        await expect(folded).toHaveCount(1);
        await running.page.keyboard.press('Meta+k');
        await running.page.keyboard.press('Meta+j');
        await expect(folded).toHaveCount(0);
        const panel = running.page.locator('section.panel');
        await expect(panel).not.toBeVisible();
        await running.page.keyboard.press('Meta+j');
        await expect(panel).toBeVisible();
        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+j');
        await expect(panel).not.toBeVisible();

        /**
         * Caxri and Monaco run independent keybinding resolvers, so ownership of a `Cmd+K` sequence is decided once, at
         * its leading chord: typed into the editor the whole sequence is Monaco's and the app command must stay inert,
         * while the same sequence typed anywhere else runs. Both halves are asserted here because only the pair proves
         * the split; either one alone passes with the app simply never binding the sequence.
         */
        // Settings is a Workbench tab now, not a modal (issue caxri#1289): `[data-settings-page]` is the
        // replacement scope for the former `role="dialog"` query (see `openSettingsTab` in `support/helpers.ts`). This
        // is checked directly rather than through that helper because the chord below is expected to open the tab on
        // its own, without `Cmd+,`.
        const settingsTab = running.page.locator('[data-settings-page]');
        await running.page.keyboard.press('Meta+k');
        await running.page.keyboard.press('Meta+s');
        await expect(settingsTab).toHaveCount(0);
        await running.page.getByRole('treeitem', { name: 'searchable.ts', exact: true }).click();
        await running.page.keyboard.press('Meta+k');
        await running.page.keyboard.press('Meta+s');
        await expect(settingsTab.getByLabel('Search keyboard shortcuts')).toBeVisible();
        // `Cmd+W` closes the tab outright, the tab-appropriate replacement for the old "Escape to
        // dismiss the dialog" step: it also occupies the same pane the editor does, so this is
        // required for `editor.click(...)` below to find it mounted again.
        await running.page.keyboard.press('Meta+w');
        await expect(settingsTab).toHaveCount(0);
        await editor.click({ position: { x: 120, y: 24 } });

        /**
         * CDP key dispatch alone does not prove native macOS menu accelerators released these keys.
         */
        expect(
            await running.app.evaluate(({ Menu }) =>
                ['terminal.clear', 'terminal.find', 'panel.toggle'].map(
                    (command) =>
                        Menu.getApplicationMenu()?.getMenuItemById(`command.${command}`)
                            ?.accelerator,
                ),
            ),
        ).toEqual([null, null, null]);
        await running.page.keyboard.press('Meta+f');
        const findWidget = editor.locator('.find-widget');
        await expect(findWidget).toBeVisible();
        await findWidget.getByRole('textbox', { name: 'Find' }).fill('needle');
        await expect(findWidget).toContainText('1 of 2');

        const matchCase = findWidget.getByRole('checkbox', { name: /Match Case/ });
        await matchCase.click();
        await expect(matchCase).toBeChecked();
        await matchCase.click();
        await expect(matchCase).not.toBeChecked();

        const closeButton = findWidget.getByRole('button', { name: /^Close \(Escape\)$/ });
        await expect(closeButton).toBeVisible();
        const closeBox = await closeButton.boundingBox();
        expect(closeBox?.width).toBeGreaterThanOrEqual(24);
        expect(closeBox?.height).toBeGreaterThanOrEqual(24);
        expect(
            await findWidget.evaluate((element) => getComputedStyle(element).transitionDuration),
        ).toBe('0s');

        await closeButton.hover();
        await running.page.waitForTimeout(300);
        expect(
            await closeButton.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return document
                    .elementFromPoint(
                        bounds.left + bounds.width / 2,
                        bounds.top + bounds.height / 2,
                    )
                    ?.closest('[aria-label]')
                    ?.getAttribute('aria-label');
            }),
        ).toBe('Close (Escape)');
        await closeButton.click();
        await expect(findWidget).toHaveAttribute('aria-hidden', 'true');

        await running.page.keyboard.press('Meta+f');
        await expect(findWidget).toHaveAttribute('aria-hidden', 'false');
        await running.page.keyboard.press('Escape');
        await expect(findWidget).toHaveAttribute('aria-hidden', 'true');
        await expect(editor).toHaveClass(/focused/);

        await running.page.keyboard.press('Meta+f');
        await expect(findWidget).toHaveAttribute('aria-hidden', 'false');
        await running.page.keyboard.press('Meta+]');
        await running.page.setViewportSize({ width: 1_000, height: 700 });
        await findWidget.getByRole('button', { name: /^Close \(Escape\)$/ }).click();
        await expect(findWidget).toHaveAttribute('aria-hidden', 'true');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
