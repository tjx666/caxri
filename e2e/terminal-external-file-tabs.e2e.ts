import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import {
    clickTerminalLink,
    createShellSession,
    launchCaxri,
    typeTerminal,
} from './support/helpers.ts';

test('reopening a Terminal external file link focuses and refreshes its existing tab', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-external-tab-e2e-'));
    const root = join(testDirectory, 'project');
    const externalFile = join(testDirectory, 'outside.sql');
    await mkdir(root, { recursive: true });
    await writeFile(externalFile, 'select 1;\n', 'utf8');
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify([root]) },
    });
    try {
        await createShellSession(running.page);
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        await typeTerminal(running.page, String.raw`printf '%s\n' '${externalFile}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(externalFile);

        await clickTerminalLink(running.page, externalFile);
        const externalTab = running.page.getByRole('tab', { name: 'outside.sql' });
        await expect(externalTab).toHaveCount(1);
        await expect(externalTab).toHaveAttribute('aria-selected', 'true');
        await expect(running.page.locator('.monaco-editor .view-lines')).toContainText('select 1;');

        await writeFile(externalFile, 'select 2;\n', 'utf8');
        await running.page.getByRole('tab', { name: 'Shell' }).click();
        await clickTerminalLink(running.page, externalFile);
        await expect(externalTab).toHaveCount(1);
        await expect(externalTab).toHaveAttribute('aria-selected', 'true');
        await expect(running.page.locator('.monaco-editor .view-lines')).toContainText('select 2;');
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
