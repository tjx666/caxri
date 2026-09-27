import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { dropFinderFiles } from './support/finder-file-drop.ts';
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

test('Editor tabs paste paths at Terminal edges by default and Option restores splitting', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-terminal-drop-e2e-'));
    const rootInput = join(testDirectory, 'project');
    await mkdir(rootInput);
    const root = await realpath(rootInput);
    const fileName = "editor with 'quote'.txt";
    await writeFile(join(root, fileName), 'fixture\n', 'utf8');
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'profile'),
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: fileName, exact: true }).dblclick();
        const editorTab = running.page.locator('.work-tab:not([data-terminal-id])');
        /**
         * The double-click open resolves asynchronously after the preview clicks; await its pinned document before
         * switching.
         */
        await expect(editorTab).not.toHaveAttribute('data-preview', 'true');
        await expect(running.page.locator('.monaco-editor')).toBeVisible();
        await expect(editorTab.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
        const terminalTab = running.page.locator('.work-tab[data-terminal-id]');
        await terminalTab.getByRole('tab').click();
        /**
         * A late Editor activation can still unmount the Terminal textarea after the click, so await the Terminal
         * owning the pane before dropping onto it.
         */
        await expect(terminalTab.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await expect(terminalInput).toBeVisible();
        const surface = running.page.locator('.pane-surface');
        const verifyDrop = async (xRatio: number): Promise<void> => {
            const receipt = join(testDirectory, `drop-${xRatio}.txt`);
            await terminalInput.click();
            await running.page.keyboard.type("printf '%s' ");
            const bounds = await surface.boundingBox();
            if (!bounds) throw new Error('Terminal surface is missing');
            await editorTab.dragTo(surface, {
                targetPosition: { x: bounds.width * xRatio, y: bounds.height / 2 },
            });
            await expect(running.page.locator('.workbench-pane')).toHaveCount(1);
            await expect(terminalInput).toBeFocused();
            await expectMissing(receipt);
            await running.page.keyboard.type(` > ${quoteShellPath(receipt)}`);
            await running.page.keyboard.press('Enter');
            await expect
                .poll(() => readFileForPoll(() => readFile(receipt, 'utf8')))
                .toBe(fileName);
        };
        await verifyDrop(0.5);
        await verifyDrop(0.05);
        const bounds = await surface.boundingBox();
        if (!bounds) throw new Error('Terminal surface is missing');
        await running.page.keyboard.down('Alt');
        try {
            await editorTab.dragTo(surface, {
                targetPosition: { x: bounds.width - 5, y: bounds.height / 2 },
            });
        } finally {
            await running.page.keyboard.up('Alt');
        }
        await expect(running.page.locator('.workbench-pane')).toHaveCount(2);
        /**
         * Pane mounts outlive the split that created them for a frame, so the page briefly holds both the retiring and
         * the relocated Editor tab. Await the single surviving tab before filtering panes by it.
         */
        await expect(editorTab).toHaveCount(1);
        // Terminal drags still use pane placement without a modifier.
        const editorSurface = running.page
            .locator('.workbench-pane')
            .filter({ has: editorTab })
            .locator('.pane-surface');
        await terminalTab.dragTo(editorSurface);
        await expect(running.page.locator('.workbench-pane')).toHaveCount(1);
    } finally {
        await running.app.close();
    }
});

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

    const linkNames = ["linked 'file'.txt", 'linked folder'];
    const externalFolder = join(testDirectory, 'shared');
    await mkdir(externalFolder);
    const externalFile = join(externalFolder, 'target.txt');
    await writeFile(externalFile, 'fixture\n');
    await symlink(externalFile, join(root, linkNames[0]));
    await symlink(externalFolder, join(root, linkNames[1]));

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const fileList = running.page.locator('.file-list').first();
        const terminalSurface = running.page.locator('.terminal-surface');
        const terminalInput = running.page.locator('.xterm-helper-textarea');

        /**
         * Keep receipts outside the watched tree so a completed drop cannot reorder the next drag source.
         */
        const assertLinkDrop = async (name: string, index: number): Promise<void> => {
            const result = join(testDirectory, `.link-drop-result-${index}`);
            await terminalInput.click();
            await running.page.keyboard.type("printf '%s' ");
            await dragEntryToTerminal(
                fileList.getByRole('treeitem', { name, exact: true }),
                terminalSurface,
            );
            await expectMissing(result);
            await expect(terminalInput).toBeFocused();
            await running.page.keyboard.type(` > ${quoteShellPath(result)}`);
            await running.page.keyboard.press('Enter');
            await expect.poll(() => readFileForPoll(() => readFile(result, 'utf8'))).toBe(name);
        };
        await assertLinkDrop(linkNames[0], 0);
        await assertLinkDrop(linkNames[1], 1);

        const fileResult = join(testDirectory, '.file-drop-result');
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

        const folderResult = join(testDirectory, '.folder-drop-result');
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
            const source = gitPanel.getByRole('treeitem', { name: fileName, exact: true });
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

test('Files dropped from Finder on a Terminal insert shell-safe cwd-relative paths', async () => {
    const testDirectory = await realpath(await mkdtemp(`${tmpdir()}/caxri-finder-drop-e2e-`));
    const root = join(testDirectory, 'project');
    const desktop = join(testDirectory, 'Desktop');
    await Promise.all([mkdir(root), mkdir(desktop)]);
    const projectFileName = "shot 'one'.png";
    const outsideFile = join(desktop, 'Screenshot 2026-09-28.png');
    await Promise.all([
        writeFile(join(root, projectFileName), 'fixture\n'),
        writeFile(outsideFile, 'fixture\n'),
    ]);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'profile'),
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page);
        const terminalInput = running.page.locator('.xterm-helper-textarea');
        const result = join(testDirectory, '.finder-drop-result');
        await terminalInput.click();
        await running.page.keyboard.type("printf '%s|' ");
        await dropFinderFiles(running.page, running.page.locator('.terminal-surface'), [
            join(root, projectFileName),
            outsideFile,
        ]);
        await expect(terminalInput).toBeFocused();
        await expectMissing(result);
        await running.page.keyboard.type(` > ${quoteShellPath(result)}`);
        await running.page.keyboard.press('Enter');
        // One argument per file: the Project file relative to the Terminal's cwd, the other absolute.
        await expect
            .poll(() => readFileForPoll(() => readFile(result, 'utf8')))
            .toBe(`${projectFileName}|${outsideFile}|`);
        await expect(running.page.locator('.workbench-pane')).toHaveCount(1);
    } finally {
        await running.app.close();
    }
});
