import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import type { Locator } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';
import { readFileForPoll } from './support/result-file-polling.ts';

function quoteShellPath(path: string): string {
    return `'${path.replaceAll("'", String.raw`'\''`)}'`;
}

async function dragEntryToTerminal(source: Locator, terminal: Locator): Promise<void> {
    await expect(source).toBeAttached();
    await source.dragTo(terminal);
}

async function expectMissing(path: string): Promise<void> {
    await expect(access(path)).rejects.toThrow();
}

test('Files entries dragged to Terminal insert shell-safe cwd-relative paths without opening an Editor', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-terminal-drag-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await mkdir(rootInput);
    const root = await realpath(rootInput);
    const fileName = "file with 'quote'.txt";
    const folderName = 'folder with spaces';
    const filePath = join(root, fileName);
    const folderPath = join(root, folderName);
    await Promise.all([writeFile(filePath, 'fixture\n', 'utf8'), mkdir(folderPath)]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const fileList = running.page.locator('.file-list').first();
        const terminalSurface = running.page.locator('.terminal-surface');
        const terminalInput = running.page.locator('.xterm-helper-textarea');

        const fileResult = join(root, '.file-drop-result');
        await terminalInput.click();
        await running.page.keyboard.type("printf '%s' ");
        await dragEntryToTerminal(
            fileList.getByRole('treeitem', { name: fileName, exact: true }),
            terminalSurface,
        );
        await expectMissing(fileResult);
        await expect(terminalInput).toBeFocused();
        await running.page.keyboard.type(` > ${quoteShellPath(fileResult)}`);
        await running.page.keyboard.press('Enter');
        // The Terminal launched in the Project root, so the drop spells the entry relative to it.
        await expect.poll(() => readFileForPoll(() => readFile(fileResult, 'utf8'))).toBe(fileName);

        const folderResult = join(root, '.folder-drop-result');
        await running.page.keyboard.type("printf '%s' ");
        await dragEntryToTerminal(
            fileList.getByRole('treeitem', { name: folderName, exact: true }),
            terminalSurface,
        );
        await expectMissing(folderResult);
        await running.page.keyboard.type(` > ${quoteShellPath(folderResult)}`);
        await running.page.keyboard.press('Enter');
        await expect
            .poll(() => readFileForPoll(() => readFile(folderResult, 'utf8')))
            .toBe(folderName);

        await expect(running.page.locator('.work-tab:not([data-terminal-id])')).toHaveCount(0);
        await expect(running.page.locator('.workbench-pane')).toHaveCount(1);
        await expect(running.page.locator('.terminal-drop-preview')).toHaveCount(0);

        await running.page.keyboard.type('exit');
        await running.page.keyboard.press('Enter');
        await expect(running.page.locator('[data-terminal-exit-state="stopped"]')).toBeVisible();
        const stoppedRows = await running.page.locator('.xterm-rows').textContent();
        await dragEntryToTerminal(
            fileList.getByRole('treeitem', { name: fileName, exact: true }),
            terminalSurface,
        );
        await expect
            .poll(() => running.page.locator('.xterm-rows').textContent())
            .toBe(stoppedRows);
        await expect(running.page.locator('.work-tab:not([data-terminal-id])')).toHaveCount(0);
        await expect(running.page.locator('.terminal-drop-preview')).toHaveCount(0);
    } finally {
        await running.app.close();
    }
});

test('Git changed files dragged to Terminal insert shell-safe paths without executing or opening an Editor', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-terminal-drag-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    const nestedRoot = join(rootInput, 'nested repo');
    await mkdir(nestedRoot, { recursive: true });

    const mainFileName = "main file with 'quote'.txt";
    const nestedFileName = "nested file with 'quote'.txt";
    const mainFilePath = join(rootInput, mainFileName);
    const nestedFilePath = join(nestedRoot, nestedFileName);
    await writeFile(mainFilePath, 'before\n', 'utf8');
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: rootInput });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], {
        cwd: rootInput,
    });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: rootInput });
    await execFileAsync('git', ['add', mainFileName], { cwd: rootInput });
    await execFileAsync('git', ['commit', '-m', 'Initial project file'], { cwd: rootInput });

    await writeFile(nestedFilePath, 'before\n', 'utf8');
    await execFileAsync('git', ['init', '-b', 'nested'], { cwd: nestedRoot });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], {
        cwd: nestedRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: nestedRoot });
    await execFileAsync('git', ['add', nestedFileName], { cwd: nestedRoot });
    await execFileAsync('git', ['commit', '-m', 'Initial nested file'], { cwd: nestedRoot });
    await Promise.all([
        writeFile(mainFilePath, 'changed\n', 'utf8'),
        writeFile(nestedFilePath, 'changed\n', 'utf8'),
    ]);

    const root = await realpath(rootInput);
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const gitPanel = running.page.locator('.git-panel');
        const terminalSurface = running.page.locator('.terminal-surface');
        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await expect(gitPanel.locator('.git-repository-section')).toHaveCount(2);

        const dragGitFile = async (
            fileName: string,
            expectedCwdPath: string,
            resultPath: string,
        ): Promise<void> => {
            const source = gitPanel.getByRole('button', { name: fileName, exact: true });
            await expect(source).toBeVisible();
            await terminalInput.click();
            await running.page.keyboard.type("printf '%s' ");
            await dragEntryToTerminal(source, terminalSurface);
            await expectMissing(resultPath);
            await expect(terminalInput).toBeFocused();
            await expect(running.page.locator('.work-tab:not([data-terminal-id])')).toHaveCount(0);
            await running.page.keyboard.type(` > ${quoteShellPath(resultPath)}`);
            await running.page.keyboard.press('Enter');
            await expect
                .poll(() => readFileForPoll(() => readFile(resultPath, 'utf8')))
                .toBe(expectedCwdPath);
        };

        /**
         * Keep command receipts outside the watched repository: adding a Git row would refresh and temporarily inert
         * the drag source while the next native drag is in flight.
         */
        await dragGitFile(mainFileName, mainFileName, join(testDirectory, '.git-main-drop-result'));
        await dragGitFile(
            nestedFileName,
            join('nested repo', nestedFileName),
            join(testDirectory, '.git-nested-drop-result'),
        );
        await expect(running.page.locator('.workbench-pane')).toHaveCount(1);
        await expect(running.page.locator('.terminal-drop-preview')).toHaveCount(0);
    } finally {
        await running.app.close();
    }
});
