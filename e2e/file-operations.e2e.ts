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
import process from 'node:process';

import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    pageRequest,
    VISIBLE_TERMINAL_INPUT,
} from './support/helpers.ts';
import {
    chooseContextMenuItem,
    contextMenuItemDisabledReason,
} from './support/native-context-menu.ts';
import { readFileForPoll } from './support/result-file-polling.ts';

async function injectTransientFileAbsence(path: string): Promise<{ restored: Promise<void> }> {
    const heldPath = `${path}.ci-parity-pending`;
    await rename(path, heldPath);
    return {
        restored: new Promise<void>((resolve, reject) => {
            setTimeout(async () => {
                try {
                    await rename(heldPath, path);
                    resolve();
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            }, 150);
        }),
    };
}

test('Files supports safe create, clipboard, reveal, Terminal, move, and Trash workflows', async () => {
    // Every conflicting move (rename, or paste/drag onto an existing name) opens the Finder-style
    // conflict dialog instead of failing flat, but `moveFile` (`file-actions.ts`) still always tries
    // `conflict: 'reject'` first so the dialog can offer Replace/Keep Both/Cancel. Those deliberate
    // probes are no longer declared here: `CONFLICT` is a caller-absorbed outcome and every boundary
    // logs it at `warn` (`isCallerHandledFailure` in `@caxri/protocol`), so the error gate never sees
    // it. The rename-onto-existing-name case explains itself inline under the name field (no toast);
    // the other three open the dialog with Replace/Keep Both/Cancel.
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
        writeFile(join(destination, 'draft copy.txt'), 'existing copy\n', 'utf8'),
        writeFile(join(sourceFolder, 'nested', 'value.txt'), 'nested\n', 'utf8'),
    ]);

    const running = await launchCaxri({
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
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
            .poll(async () => {
                try {
                    await access(join(root, 'created-folder'));
                    return true;
                } catch {
                    return false;
                }
            })
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
        await expect(fileList.getByRole('alert')).toContainText('Unable to rename item.');
        await expect(conflictingName).toBeVisible();
        // The inline message is the only explanation; no second notification repeats it (issue #987).
        await expect(running.page.locator('.toast')).toHaveCount(0);
        await conflictingName.press('Escape');
        await expect(createdRow).toBeFocused();

        // Auto-reveal can leave `destination` expanded later in the workflow, so bind root files by
        // their tree level instead of a display name alone, which may also appear in that directory.
        // The row shows its path in a hover tooltip, not a native `title`, so `getByTitle` cannot match it.
        const draftRow = fileList.getByRole('treeitem', {
            name: 'draft.txt',
            exact: true,
            level: 1,
        });
        const destinationRow = fileList.getByRole('treeitem', {
            name: 'destination',
            exact: true,
        });
        // Focusing `createdRow` above opens its path tooltip, which can sit over `draftRow` and
        // intercept the click. Escape dismisses it without moving focus off the tree.
        await running.page.keyboard.press('Escape');
        await expect(running.page.getByRole('tooltip')).toHaveCount(0);
        await draftRow.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Copy Path');
        await expect.poll(() => running.clipboard.textEquals(join(root, 'draft.txt'))).toBe(true);
        await running.clipboard.claimText(join(root, 'draft.txt'));
        await draftRow.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Copy Relative Path');
        await expect.poll(() => running.clipboard.textEquals('draft.txt')).toBe(true);
        await running.clipboard.claimText('draft.txt');

        await draftRow.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Reveal in Finder');
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const value: unknown = Reflect.get(globalThis, '__caxriRevealedPath');
                    return typeof value === 'string' ? value : undefined;
                }),
            )
            .toBe(join(root, 'draft.txt'));

        const initialBootstrapState = await pageRequest<{ terminals: unknown[] }>(
            running.page,
            'app.bootstrap',
        );
        const terminalCount = initialBootstrapState.terminals.length;
        await draftRow.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Open in Terminal');
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
        await expect(running.page.locator(VISIBLE_TERMINAL_INPUT).last()).toBeFocused();

        /**
         * Nothing has been copied yet, so the Files background menu says why Paste is unavailable instead of only
         * graying it out. New File from the same menu replays the focus a real menu hands back as it closes (issue
         * #1348): the inline name field must still hold focus afterwards, taking typing without a click into it.
         */
        const fileListBox = await fileList.boundingBox();
        if (!fileListBox) throw new Error('The Files list has no layout box');
        await fileList.click({ button: 'right', position: { x: 24, y: fileListBox.height - 12 } });
        expect(await contextMenuItemDisabledReason(running.app, 'Paste')).toBe('Nothing to paste');
        await chooseContextMenuItem(running.app, 'New File', { refocusOnClose: true });
        const menuFileName = running.page.getByRole('textbox', { name: 'New file name' });
        await expect(menuFileName).toBeFocused();
        await running.page.keyboard.type('typed-after-menu.txt');
        await expect(menuFileName).toHaveValue('typed-after-menu.txt');
        await menuFileName.press('Escape');
        await expect(menuFileName).toHaveCount(0);

        await draftRow.focus();
        await expect(draftRow).toBeFocused();
        await running.page.keyboard.press('Meta+C');
        await destinationRow.focus();
        await expect(destinationRow).toBeFocused();
        await running.page.keyboard.press('Meta+V');
        const copiedDraft = join(destination, 'draft.txt');
        let restoreDraft: Promise<void> | undefined;
        if (process.env.CAXRI_CI_PARITY_CASE === 'transient-enoent') {
            await expect
                .poll(() => readFileForPoll(() => readFile(copiedDraft, 'utf8')))
                .toBe('draft\n');
            restoreDraft = (await injectTransientFileAbsence(copiedDraft)).restored;
        }
        let isObservedTransientAbsence = false;
        await expect
            .poll(async () => {
                const contents = await readFileForPoll(() => readFile(copiedDraft, 'utf8'));
                if (contents === undefined) isObservedTransientAbsence = true;
                return contents;
            })
            .toBe('draft\n');
        await restoreDraft;
        if (restoreDraft) expect(isObservedTransientAbsence).toBe(true);

        await draftRow.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Duplicate');
        await expect
            .poll(async () => {
                try {
                    return await readFile(join(root, 'draft copy.txt'), 'utf8');
                } catch {
                    return;
                }
            })
            .toBe('draft\n');

        const sourceFolderRow = fileList.getByRole('treeitem', {
            name: 'source-folder',
            exact: true,
        });
        await sourceFolderRow.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Copy');
        await destinationRow.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Paste');
        await expect
            .poll(async () => {
                try {
                    return await readFile(
                        join(destination, 'source-folder', 'nested', 'value.txt'),
                        'utf8',
                    );
                } catch {
                    return;
                }
            })
            .toBe('nested\n');

        // `level: 1`: the pastes above revealed `destination`, whose own `cut.txt` is now listed too.
        const cutRow = fileList.getByRole('treeitem', { name: 'cut.txt', exact: true, level: 1 });
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
        // Pasting onto an existing name no longer fails flat: `moveFile` (`file-actions.ts`) always
        // tries `conflict: 'reject'` first, catches the resulting `CONFLICT`, and opens the Finder-
        // style prompt below instead of the old error toast. Cut-paste and drag-and-drop now share
        // this same interactive flow rather than one silently auto-suffixing and the other refusing
        // outright.
        const conflictDialog = running.page.locator('.file-conflict-dialog');
        await destinationRow.focus();
        await running.page.keyboard.press('Meta+V');
        await expect(conflictDialog).toBeVisible();
        await expect(conflictDialog).toContainText('"cut.txt" already exists');
        await expect(
            running.page.locator('.toast', {
                hasText: 'A file or folder with that name already exists',
            }),
        ).toHaveCount(0);

        // Cancel: nothing moves, and the cut clipboard stays armed for another attempt.
        await conflictDialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(conflictDialog).toBeHidden();
        await expect(readFile(join(destination, 'cut.txt'), 'utf8')).resolves.toBe('existing\n');
        await expect(access(join(destination, 'cut copy.txt'))).rejects.toThrow();
        await expect(readFile(join(root, 'cut.txt'), 'utf8')).resolves.toBe('cut\n');
        await expect(cutRow).toHaveAttribute('data-cut', 'true');

        // Replace: retrying the same armed clipboard overwrites the existing destination file in
        // place. The moved file keeps `cut.txt`'s own name (no auto-suffix), so the unsaved buffer
        // and the save below both follow it to `destination/cut.txt` instead of a freshly named path.
        await destinationRow.focus();
        await running.page.keyboard.press('Meta+V');
        await expect(conflictDialog).toBeVisible();
        await conflictDialog.getByRole('button', { name: 'Replace' }).click();
        const cutMovedPath = join(destination, 'cut.txt');
        await expect
            .poll(async () => {
                try {
                    return await readFile(cutMovedPath, 'utf8');
                } catch {
                    return;
                }
            })
            .toBe('cut\n');
        await expect(access(join(root, 'cut.txt'))).rejects.toThrow();
        // The unsaved buffer follows the file to its new path instead of being stranded on the old
        // one: the tab stays dirty and the save below has to land at `cutMovedPath`.
        await expect(cutTab).toContainText('●');
        await cutTab.click();
        await running.page.keyboard.press('Meta+S');
        await expect.poll(() => readFile(cutMovedPath, 'utf8')).toContain(' moved');

        // Keep Both: even though Replace is offered for this file-over-file collision too, choosing
        // Keep Both auto-suffixes the moved file instead, leaving the destination's original entry
        // untouched, the same guarantee the old flat rejection used to promise before this dialog.
        const draftCopyRow = fileList.getByRole('treeitem', {
            name: 'draft copy.txt',
            exact: true,
            level: 1,
        });
        await draftCopyRow.dragTo(destinationRow);
        await expect(conflictDialog).toBeVisible();
        await conflictDialog.getByRole('button', { name: 'Keep Both' }).click();
        const keepBothPath = join(destination, 'draft copy copy.txt');
        await expect
            .poll(async () => {
                try {
                    return await readFile(keepBothPath, 'utf8');
                } catch {
                    return;
                }
            })
            .toBe('draft\n');
        await expect(readFile(join(destination, 'draft copy.txt'), 'utf8')).resolves.toBe(
            'existing copy\n',
        );
        await expect(access(join(root, 'draft copy.txt'))).rejects.toThrow();

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
            .poll(async () => {
                try {
                    await access(movedPath);
                    return true;
                } catch {
                    return false;
                }
            })
            .toBe(true);
        await expect(destinationRow).toHaveAttribute('aria-expanded', 'true');
        const movedRow = fileList.getByRole('treeitem', {
            name: 'renamed.txt',
            exact: true,
            level: 2,
        });
        await expect(movedRow).toBeVisible();

        await renamedTab.click();
        await running.page.keyboard.press('Meta+S');
        await expect
            .poll(async () => {
                try {
                    return await readFile(movedPath, 'utf8');
                } catch {
                    return '';
                }
            })
            .toContain(' dirty');

        await movedRow.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Move to Trash');
        await expect
            .poll(async () => {
                try {
                    await access(`${movedPath}.trashed`);
                    return true;
                } catch {
                    return false;
                }
            })
            .toBe(true);
        await expect(access(movedPath)).rejects.toThrow();
        await expect(renamedTab).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
