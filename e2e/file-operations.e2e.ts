import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowE2EErrors, expect, test, type Locator, type Page } from './fixtures.ts';

import { createProjectSession, launchCaxri, pageRequest } from './helpers.ts';

/**
 * Context menu items now carry a visible live-keybinding hint (`ContextMenuItem`'s `hint` prop, see
 * `context-menu.tsx`), so an item's full accessible name is no longer just its label — "Copy" reads
 * as "Copy⌘C" once the shortcut badge renders. Matching by the label's own exact text (rather than
 * the whole menuitem's accessible name) keeps this test independent of that badge's exact rendering
 * while still disambiguating "Copy" from "Copy Path" / "Copy Relative Path" in the same menu.
 */
function exactMenuItem(page: Page, label: string): Locator {
    return page.getByRole('menuitem').filter({ has: page.getByText(label, { exact: true }) });
}

async function readExpectedFile(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

async function injectTransientFileAbsence(path: string): Promise<{ restored: Promise<void> }> {
    const heldPath = `${path}.ci-parity-pending`;
    await rename(path, heldPath);
    return {
        restored: new Promise<void>((resolveRestore, rejectRestore) => {
            setTimeout(() => void rename(heldPath, path).then(resolveRestore, rejectRestore), 150);
        }),
    };
}

test('Files supports safe create, clipboard, reveal, Terminal, move, and Trash workflows', async () => {
    // Two deliberate collisions: renaming onto an existing name, and pasting a cut file into a
    // directory that already holds that name. The second one used to auto-rename instead of
    // failing, so its `CONFLICT` pair is new rather than an unexplained count bump.
    allowE2EErrors([
        { source: 'main', event: 'ipc.request_failed', code: 'CONFLICT', count: 2 },
        { source: 'runtime', event: 'ipc.request_failed', code: 'CONFLICT', count: 2 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-operations-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await mkdir(rootInput);
    const root = await realpath(rootInput);
    const destination = join(root, 'destination');
    const sourceFolder = join(root, 'source-folder');
    await Promise.all([
        mkdir(destination, { recursive: true }),
        mkdir(join(sourceFolder, 'nested'), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(join(root, 'cut.txt'), 'cut\n', 'utf8'),
        writeFile(join(root, 'draft.txt'), 'draft\n', 'utf8'),
        writeFile(join(destination, 'cut.txt'), 'existing\n', 'utf8'),
        writeFile(join(sourceFolder, 'nested', 'value.txt'), 'nested\n', 'utf8'),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await running.app.evaluate(({ dialog, shell }) => {
            const { rename } = process.getBuiltinModule('node:fs').promises;
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
            shell.showItemInFolder = (path) => {
                Reflect.set(globalThis, '__caxriRevealedPath', path);
            };
            shell.trashItem = (path) => rename(path, `${path}.trashed`);
        });
        await createProjectSession(running.page);

        const caption = running.page.locator('.panel-caption');
        await caption.hover();
        await caption.getByRole('button', { name: 'New File' }).click();
        const newFileName = running.page.getByRole('textbox', { name: 'New file name' });
        await newFileName.fill('created.txt');
        await newFileName.press('Enter');
        await expect(running.page.locator('.work-tab', { hasText: 'created.txt' })).toBeVisible();
        await expect(
            running.page
                .locator('.file-list')
                .first()
                .getByRole('treeitem', { name: 'created.txt', exact: true }),
        ).toBeFocused();
        await expect(readFile(join(root, 'created.txt'), 'utf8')).resolves.toBe('');

        const newFolderButton = caption.getByRole('button', { name: 'New Folder' });
        await newFolderButton.click();
        await running.page.getByRole('textbox', { name: 'New folder name' }).press('Escape');
        await expect(newFolderButton).toBeFocused();
        await newFolderButton.click();
        const newFolderName = running.page.getByRole('textbox', { name: 'New folder name' });
        await newFolderName.fill('created-folder');
        await newFolderName.press('Enter');
        await expect(
            running.page
                .locator('.file-list')
                .first()
                .getByRole('treeitem', { name: 'created-folder', exact: true }),
        ).toBeFocused();
        await expect
            .poll(() =>
                access(join(root, 'created-folder'))
                    .then(() => true)
                    .catch(() => false),
            )
            .toBe(true);

        const fileList = running.page.locator('.file-list').first();
        const createdRow = fileList.getByRole('treeitem', { name: 'created.txt', exact: true });
        await createdRow.focus();
        await running.page.keyboard.press('Enter');
        const conflictingName = running.page.getByRole('textbox', { name: 'Rename created.txt' });
        await conflictingName.fill('draft.txt');
        await conflictingName.press('Enter');
        await expect(fileList.getByRole('alert')).toContainText(
            'A file or folder with that name already exists',
        );
        await expect(conflictingName).toBeVisible();
        await conflictingName.press('Escape');
        await expect(createdRow).toBeFocused();

        const draftRow = fileList.getByRole('treeitem', { name: 'draft.txt', exact: true });
        const destinationRow = fileList.getByRole('treeitem', {
            name: 'destination',
            exact: true,
        });
        await draftRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Copy Path', exact: true }).click();
        await expect
            .poll(() => running.app.evaluate(({ clipboard }) => clipboard.readText()))
            .toBe(join(root, 'draft.txt'));
        await draftRow.click({ button: 'right' });
        await running.page
            .getByRole('menuitem', { name: 'Copy Relative Path', exact: true })
            .click();
        await expect
            .poll(() => running.app.evaluate(({ clipboard }) => clipboard.readText()))
            .toBe('draft.txt');

        await draftRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Reveal in Finder' }).click();
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const value: unknown = Reflect.get(globalThis, '__caxriRevealedPath');
                    return typeof value === 'string' ? value : undefined;
                }),
            )
            .toBe(join(root, 'draft.txt'));

        const terminalCount = await pageRequest<{ terminals: unknown[] }>(
            running.page,
            'app.bootstrap',
        ).then((state) => state.terminals.length);
        await draftRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Open in Terminal' }).click();
        await expect
            .poll(async () => {
                const state = await pageRequest<{ terminals: Array<{ cwd: string }> }>(
                    running.page,
                    'app.bootstrap',
                );
                return {
                    count: state.terminals.length,
                    cwd: state.terminals.at(-1)?.cwd,
                };
            })
            .toEqual({ count: terminalCount + 1, cwd: root });
        await expect(running.page.locator('.xterm-helper-textarea').last()).toBeFocused();

        await draftRow.focus();
        await expect(draftRow).toBeFocused();
        await running.page.keyboard.press('Meta+C');
        await destinationRow.focus();
        await expect(destinationRow).toBeFocused();
        await running.page.keyboard.press('Meta+V');
        const copiedDraft = join(destination, 'draft.txt');
        let restoreDraft: Promise<void> | undefined;
        if (process.env.CAXRI_CI_PARITY_CASE === 'transient-enoent') {
            await expect.poll(() => readExpectedFile(copiedDraft)).toBe('draft\n');
            restoreDraft = (await injectTransientFileAbsence(copiedDraft)).restored;
        }
        let observedTransientAbsence = false;
        await expect
            .poll(async () => {
                const contents = await readExpectedFile(copiedDraft);
                if (contents === undefined) observedTransientAbsence = true;
                return contents;
            })
            .toBe('draft\n');
        await restoreDraft;
        if (restoreDraft) expect(observedTransientAbsence).toBe(true);

        await draftRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Duplicate' }).click();
        await expect
            .poll(() => readFile(join(root, 'draft copy.txt'), 'utf8').catch(() => undefined))
            .toBe('draft\n');

        const sourceFolderRow = fileList.getByRole('treeitem', {
            name: 'source-folder',
            exact: true,
        });
        await sourceFolderRow.click({ button: 'right' });
        await exactMenuItem(running.page, 'Copy').click();
        await destinationRow.click({ button: 'right' });
        await exactMenuItem(running.page, 'Paste').click();
        await expect
            .poll(() =>
                readFile(join(destination, 'source-folder', 'nested', 'value.txt'), 'utf8').catch(
                    () => undefined,
                ),
            )
            .toBe('nested\n');

        const cutRow = fileList.getByRole('treeitem', { name: 'cut.txt', exact: true });
        await cutRow.dblclick();
        await running.page.locator('.monaco-editor').click({ position: { x: 100, y: 24 } });
        await running.page.keyboard.press('End');
        await running.page.keyboard.type(' moved');
        // `:not([inert])` because the move below remaps the tab to the new path and leaves the old
        // one on screen as an inert exit-animation ghost with the same label, exactly as the rename
        // case further down already has to handle.
        const cutTab = running.page.locator('.work-tab:not([inert])', { hasText: 'cut.txt' });
        await expect(cutTab).toContainText('●');
        await cutRow.focus();
        await running.page.keyboard.press('Meta+X');
        await expect(cutRow).toHaveAttribute('data-cut', 'true');
        // Pasting onto an existing name is rejected, never silently auto-suffixed to "cut copy.txt".
        // Cut-paste used to pass `conflict: 'rename'` while drag-and-drop passed `'reject'`, so the
        // same collision either moved the file somewhere the user never named or refused outright
        // depending on how it was triggered (`file-actions.ts`'s `moveFile` doc comment). Both now
        // reject and explain themselves through the same error toast.
        await destinationRow.focus();
        await running.page.keyboard.press('Meta+V');
        await expect(
            running.page.locator('.toast', {
                hasText: 'A file or folder with that name already exists',
            }),
        ).toBeVisible();
        await expect(readFile(join(destination, 'cut.txt'), 'utf8')).resolves.toBe('existing\n');
        await expect(access(join(destination, 'cut copy.txt'))).rejects.toThrow();
        await expect(readFile(join(root, 'cut.txt'), 'utf8')).resolves.toBe('cut\n');
        // The rejection leaves the clipboard armed, so retrying somewhere else costs no second cut.
        await expect(cutRow).toHaveAttribute('data-cut', 'true');

        const createdFolderRow = fileList.getByRole('treeitem', {
            name: 'created-folder',
            exact: true,
        });
        await createdFolderRow.focus();
        await running.page.keyboard.press('Meta+V');
        const cutMovedPath = join(root, 'created-folder', 'cut.txt');
        await expect
            .poll(() => readFile(cutMovedPath, 'utf8').catch(() => undefined))
            .toBe('cut\n');
        await expect(access(join(root, 'cut.txt'))).rejects.toThrow();
        // The unsaved buffer follows the file to its new path instead of being stranded on the old
        // one: the tab stays dirty and the save below has to land at `cutMovedPath`.
        await expect(cutTab).toContainText('●');
        await cutTab.click();
        await running.page.keyboard.press('Meta+S');
        await expect.poll(() => readFile(cutMovedPath, 'utf8')).toContain(' moved');

        await draftRow.dblclick();
        await running.page.locator('.monaco-editor').click({ position: { x: 100, y: 24 } });
        await running.page.keyboard.press('End');
        await running.page.keyboard.type(' dirty');
        const draftTab = running.page.locator('.work-tab', { hasText: 'draft.txt' });
        await expect(draftTab).toContainText('●');

        await draftRow.focus();
        await running.page.keyboard.press('Enter');
        const renameInput = running.page.getByRole('textbox', { name: 'Rename draft.txt' });
        await renameInput.fill('renamed.txt');
        await renameInput.press('Enter');
        const renamedTab = running.page.locator('.work-tab:not([inert])', {
            hasText: 'renamed.txt',
        });
        await expect(renamedTab).toContainText('●');
        await expect(access(join(root, 'draft.txt'))).rejects.toThrow();
        await expect(access(join(root, 'renamed.txt'))).resolves.toBeUndefined();

        const renamedRow = fileList.getByRole('treeitem', { name: 'renamed.txt', exact: true });
        await expect(renamedRow).toBeFocused();
        await renamedRow.dragTo(destinationRow);
        const movedPath = join(destination, 'renamed.txt');
        await expect
            .poll(() =>
                access(movedPath)
                    .then(() => true)
                    .catch(() => false),
            )
            .toBe(true);
        await destinationRow.click();
        const movedRow = running.page
            .locator('.file-list')
            .getByRole('treeitem', { name: 'renamed.txt', exact: true });
        await expect(movedRow).toBeVisible();

        await renamedTab.click();
        await running.page.keyboard.press('Meta+S');
        await expect.poll(() => readFile(movedPath, 'utf8').catch(() => '')).toContain(' dirty');

        await movedRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Move to Trash' }).click();
        await expect
            .poll(() =>
                access(`${movedPath}.trashed`)
                    .then(() => true)
                    .catch(() => false),
            )
            .toBe(true);
        await expect(access(movedPath)).rejects.toThrow();
        await expect(renamedTab).toHaveCount(0);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
