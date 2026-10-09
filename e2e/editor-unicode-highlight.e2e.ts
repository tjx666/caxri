import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

/**
 * Full-width CJK punctuation is "ambiguous" to Monaco; VS Code stops flagging it in Markdown and plain text, while code
 * keeps the warning. One editor switches between both files because Monaco merges option updates, so a code file opened
 * after a Markdown file must turn the highlight back on.
 */
test('Markdown skips ambiguous-character highlights that code files keep', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-unicode-highlight-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root);
    await Promise.all([
        writeFile(join(root, 'guide.md'), '# Guide\n\nCustomer：Example Limited\n'),
        writeFile(join(root, 'code.ts'), "export const label = 'key：value';\n"),
    ]);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'profile'),
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page);
        const tree = running.page.getByRole('tree', { name: 'Files' });
        const editor = running.page.locator('.monaco-editor').last();
        const highlights = running.page.locator('.monaco-editor .unicode-highlight');

        await tree.getByRole('treeitem', { name: /^code\.ts/ }).dblclick();
        await expect(editor.locator('.view-lines')).toContainText('key');
        await expect(highlights).toHaveCount(1);

        await tree.getByRole('treeitem', { name: /^guide\.md/ }).dblclick();
        await expect(editor.locator('.view-lines')).toContainText('Customer');
        await expect(highlights).toHaveCount(0);

        await tree.getByRole('treeitem', { name: /^code\.ts/ }).dblclick();
        await expect(editor.locator('.view-lines')).toContainText('key');
        await expect(highlights).toHaveCount(1);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
