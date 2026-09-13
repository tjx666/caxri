import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

test('Status Bar neighbors stay fixed across cursor digits and blame content', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-statusbar-stable-width-e2e-'));
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    const lines = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(root, 'tracked.txt'), `${lines.join('\n')}\n`);
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'Short'], { cwd: root });
    lines[10] = 'line 11 changed';
    await writeFile(join(root, 'tracked.txt'), `${lines.join('\n')}\n`);
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
    await execFileAsync(
        'git',
        ['commit', '-m', 'A deliberately much longer commit subject for blame width'],
        { cwd: root },
    );

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: 'tracked.txt', exact: true }).click();
        const editor = running.page.locator('.monaco-editor').first();
        await editor.click({ position: { x: 80, y: 12 } });
        await expect(running.page.locator('.statusbar-selection')).toContainText('Ln 1, Col');
        for (let index = 0; index < 8; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- each key press must move the cursor before the next one.
            await running.page.keyboard.press('ArrowDown');
        }

        const blame = running.page.locator('.statusbar-blame');
        const selection = running.page.locator('.statusbar-selection');
        const language = running.page.locator('.statusbar-language');
        const statusbarBounds = await running.page.locator('.statusbar').boundingBox();
        if (!statusbarBounds) throw new Error('Status Bar has no bounds');
        const captureStatusBar = async (name: string) =>
            running.page.screenshot({
                path: test.info().outputPath(name),
                clip: {
                    x: statusbarBounds.x,
                    y: statusbarBounds.y,
                    width: statusbarBounds.width,
                    height: statusbarBounds.height,
                },
            });
        await expect(selection).toContainText('Ln 9, Col');
        await expect(blame).toHaveAttribute('aria-label', /Short/);
        const atNine = {
            selection: await selection.boundingBox(),
            language: await language.boundingBox(),
        };
        await captureStatusBar('line-9.png');

        await running.page.keyboard.press('ArrowDown');
        await expect(selection).toContainText('Ln 10, Col');
        await expect(blame).toHaveAttribute('aria-label', /Short/);
        const atTen = {
            selection: await selection.boundingBox(),
            language: await language.boundingBox(),
        };
        await captureStatusBar('line-10.png');
        expect(atTen.language?.x).toBe(atNine.language?.x);

        await running.page.keyboard.press('ArrowDown');
        await expect(selection).toContainText('Ln 11, Col');
        await expect(blame).toHaveAttribute(
            'aria-label',
            /A deliberately much longer commit subject/,
        );
        const atEleven = {
            selection: await selection.boundingBox(),
            language: await language.boundingBox(),
        };
        await captureStatusBar('line-11.png');
        expect(atEleven.selection?.x).toBe(atTen.selection?.x);
        expect(atEleven.language?.x).toBe(atTen.language?.x);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
