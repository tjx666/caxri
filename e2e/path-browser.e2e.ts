import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    waitForRuntimeReady,
} from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';

test('Cmd+P lazily browses Project paths from Terminal, Editor, and Files focus', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-path-browser-e2e-'));
    const root = join(testDirectory, 'project');
    const userData = join(testDirectory, 'user-data');
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await Promise.all([
        writeFile(join(root, 'README.md'), '# Project\n', 'utf8'),
        writeFile(
            join(root, 'src', 'nested', 'target.ts'),
            'export const target = true;\n',
            'utf8',
        ),
        writeFile(join(root, 'real-file.ts'), 'export const real = true;\n', 'utf8'),
    ]);
    await Promise.all([
        /**
         * The link names carry no type, so only the Server-side target probe can supply one for the dialog icons. The
         * directory link is named to sort after `src` inside the directory group it now joins, so the assertions below
         * still address `src` as the first option and as an unambiguous accessible name.
         */
        symlink('src', join(root, 'zz-link-to-dir')),
        symlink('real-file.ts', join(root, 'link-to-file')),
        symlink('./missing', join(root, 'broken-link')),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);

        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await terminalInput.focus();
        await expect(terminalInput).toBeFocused();
        await running.page.keyboard.press('Meta+P');
        let dialog = running.page.getByRole('dialog');
        let input = dialog.getByRole('combobox', { name: 'File path' });
        await expect(input).toBeFocused();
        const rootListbox = dialog.getByRole('listbox', { name: 'Files' });
        const rootDirectoryOption = dialog.getByRole('option', { name: /^src( Directory)?$/ });
        await expect(rootDirectoryOption).toBeVisible();
        // A symlink row shows the icon of whatever its target is, not an untyped placeholder under the badge.
        await expect(
            rootListbox.locator(
                '[data-symlink-icon="directory"] [data-file-icon="default_folder"]',
            ),
        ).toBeVisible();
        await expect(
            rootListbox.locator(
                '[data-symlink-icon="file"] [data-file-icon="file_type_typescript"]',
            ),
        ).toBeVisible();
        await expect(
            rootListbox.locator('[data-symlink-icon="broken"] [data-file-icon="default_file"]'),
        ).toBeVisible();
        // Workspace links retain their target description and participate in navigation.
        const directoryLinkOption = dialog.getByRole('option', {
            name: 'zz-link-to-dir',
            exact: false,
        });
        await expect(directoryLinkOption).toHaveAttribute('aria-disabled', 'false');
        await expect(directoryLinkOption).toHaveAttribute('title', 'Symlink to src.');
        await expect(directoryLinkOption).toHaveAccessibleDescription('Symlink to src.');
        const rootListboxId = await rootListbox.getAttribute('id');
        const rootOptionId = await rootDirectoryOption.getAttribute('id');
        expect(rootListboxId).not.toBeNull();
        expect(rootOptionId).not.toBeNull();
        await expect(input).toHaveAttribute('aria-controls', rootListboxId!);
        await expect(input).toHaveAttribute('aria-activedescendant', rootOptionId!);
        await input.dispatchEvent('keydown', {
            bubbles: true,
            code: 'Enter',
            isComposing: true,
            key: 'Enter',
        });
        await expect(dialog.getByRole('button', { name: 'Parent directory' })).toBeDisabled();
        await expect(rootDirectoryOption).toBeVisible();
        const firstActiveOption = await input.getAttribute('aria-activedescendant');
        await input.press('ArrowDown');
        await expect
            .poll(() => input.getAttribute('aria-activedescendant'))
            .not.toBe(firstActiveOption);
        await expect(dialog.getByText('target.ts')).toHaveCount(0);
        await input.fill('read');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Tab');
        await expect(input).toHaveValue('README.md');
        await input.press('Enter');
        await expect(dialog).toHaveCount(0);
        const readmeTab = running.page.locator('.work-tab', { hasText: 'README.md' });
        await expect(readmeTab).toBeVisible();
        /**
         * Picking a file and pressing Enter puts the keyboard in the Editor, with no focus ring left on the new
         * Document tab and no pointer needed. Asserted without clicking the Editor first: that click used to be
         * required, and what it hid was that focus recovery had claimed the tab button instead.
         */
        const editor = running.page.locator('.monaco-editor').first();
        await expect
            .poll(() => editor.evaluate((element) => element.contains(document.activeElement)))
            .toBe(true);
        await expect(readmeTab.locator(':focus')).toHaveCount(0);
        // A path tooltip opened from tab focus would hang over the top-left of the Editor with nothing to dismiss it.
        await expect(running.page.locator('.tooltip-popup')).toHaveCount(0);
        await running.page.keyboard.press('Meta+P');
        dialog = running.page.getByRole('dialog');
        input = dialog.getByRole('combobox', { name: 'File path' });
        await input.fill('sr');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('ArrowRight');
        await expect(dialog).toContainText('src/');
        await input.fill('nest');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Enter');
        await expect(dialog).toContainText('src/nested/');
        await input.fill('tar');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Tab');
        await expect(input).toHaveValue('target.ts');
        await input.press('Enter');
        await expect(running.page.locator('.work-tab', { hasText: 'target.ts' })).toBeVisible();

        const readmeFileRow = running.page
            .locator('.file-list')
            .getByRole('treeitem', { name: 'README.md', exact: true });
        await readmeFileRow.focus();
        await running.page.keyboard.press('Meta+P');
        dialog = running.page.getByRole('dialog');
        input = dialog.getByRole('combobox', { name: 'File path' });
        await input.fill('sr');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Enter');
        await expect(dialog).toContainText('src/');
        await input.press('ArrowLeft');
        await expect(dialog.getByRole('option', { name: /^src( Directory)?$/ })).toBeVisible();
        await input.fill('sr');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Enter');
        await input.fill('../');
        await expect(dialog.getByRole('option', { name: 'README.md' })).toBeVisible();
        await input.press('Escape');
        await expect(dialog).toHaveCount(0);

        await running.page.keyboard.press('Alt+P');
        await expect(running.page.getByRole('dialog')).toHaveCount(0);
        await running.page.keyboard.press('Meta+Shift+P');
        await expect(running.page.getByRole('dialog')).toContainText('Commands');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Cmd+P removes the Project anchor and opens an external file without a picker or workspace mutation', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-path-browser-external-e2e-'));
    const root = join(testDirectory, 'project');
    const externalRoot = join(testDirectory, 'external');
    const userData = join(testDirectory, 'user-data');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(externalRoot, { recursive: true })]);
    await Promise.all([
        writeFile(join(root, 'project-only.ts'), 'export const projectOnly = true;\n'),
        writeFile(
            join(externalRoot, 'external-only.ts'),
            'export const externalOnly = "external path browser E2E";\n',
        ),
    ]);

    const running = await launchCaxri({
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const before = await pageRequest<{
            projects: Array<{ id: string; rootPath: string }>;
            selectedSessionId?: string;
            sessions: Array<{ id: string }>;
        }>(running.page, 'app.bootstrap');
        const workspaceIdentity = {
            projectIds: before.projects.map(({ id }) => id),
            selectedSessionId: before.selectedSessionId,
            sessionIds: before.sessions.map(({ id }) => id),
        };
        expect(workspaceIdentity.selectedSessionId).toBeTruthy();
        expect(before.projects).toHaveLength(1);
        const projectRoot = before.projects[0].rootPath;

        /**
         * Project creation has already consumed the deterministic picker fixture. Remove that seam and replace the real
         * Main dialog with a counter so an accidental path-browser picker call cannot open macOS UI or hide behind the
         * E2E root fallback.
         */
        await running.app.evaluate(({ dialog }) => {
            const probe = globalThis as typeof globalThis & {
                __caxriPathBrowserOpenDialogCalls?: number;
            };
            delete process.env.CAXRI_TEST_ROOT_PATH;
            delete process.env.CAXRI_TEST_ROOT_PATHS;
            probe.__caxriPathBrowserOpenDialogCalls = 0;
            dialog.showOpenDialog = () => {
                probe.__caxriPathBrowserOpenDialogCalls =
                    (probe.__caxriPathBrowserOpenDialogCalls ?? 0) + 1;
                return Promise.resolve({ canceled: true, filePaths: [] });
            };
        });

        await running.page.locator('.xterm-helper-textarea').focus();
        await running.page.keyboard.press('Meta+P');
        const dialog = running.page.getByRole('dialog');
        const input = dialog.getByRole('combobox', { name: 'File path' });
        await expect(input).toBeFocused();
        await expect(input).toHaveAttribute('aria-describedby', 'path-browser-project-anchor-help');
        await expect(dialog.getByText('project/', { exact: true })).toBeVisible();

        await input.press('Backspace');
        /*
         * The location moves to the breadcrumb, not into the field. Detaching the anchor exists so the user can type a
         * path of their own, and handing them the absolute path they are already standing on means deleting it first.
         */
        const freeDirectoryLabel = projectRoot === '/' ? '/' : `${projectRoot}/`;
        await expect(input).toHaveValue('');
        await expect(dialog.getByTitle(freeDirectoryLabel, { exact: true })).toBeVisible();
        await expect(dialog.getByText('project/', { exact: true })).toHaveCount(0);

        const missingDirectory = `${join(testDirectory, 'missing')}/`;
        await input.fill(missingDirectory);
        await expect(dialog.getByRole('alert')).toContainText('File not found');
        const projectFilter = `${projectRoot}/project`;
        await input.fill(projectFilter);
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await expect(
            dialog.getByRole('option', { name: 'project-only.ts', exact: true }),
        ).toBeVisible();
        await expect(dialog.getByRole('alert')).toHaveCount(0);

        const externalFilter = `${externalRoot}/external`;
        await input.fill(externalFilter);
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await expect(input).toHaveValue(externalFilter);
        await expect(
            dialog.getByRole('option', { name: 'external-only.ts', exact: true }),
        ).toBeVisible();
        await expect(dialog.locator('.path-browser-create')).toHaveCount(0);

        await input.press('Enter');
        await expect(dialog).toHaveCount(0);
        const externalTab = running.page.getByRole('tab', {
            name: 'external-only.ts',
            exact: true,
        });
        await expect(externalTab).toBeVisible();
        await expect(externalTab).toHaveAttribute('aria-selected', 'true');
        await externalTab.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Copy Path');
        const externalPath = await realpath(join(externalRoot, 'external-only.ts'));
        await expect.poll(() => running.clipboard.textEquals(externalPath)).toBe(true);
        await running.clipboard.claimText(externalPath);
        const editor = running.page.locator('.monaco-editor').first();
        await expect(editor).toContainText('external path browser E2E');
        await editor.getByRole('textbox', { name: 'Editor content' }).focus();
        await running.page.keyboard.type('external-mutation-must-not-appear');
        await expect(editor).not.toContainText('external-mutation-must-not-appear');
        await expect(editor).toContainText('external path browser E2E');

        const after = await pageRequest<{
            projects: Array<{ id: string }>;
            selectedSessionId?: string;
            sessions: Array<{ id: string }>;
        }>(running.page, 'app.bootstrap');
        expect({
            projectIds: after.projects.map(({ id }) => id),
            selectedSessionId: after.selectedSessionId,
            sessionIds: after.sessions.map(({ id }) => id),
        }).toEqual(workspaceIdentity);
        expect(
            await running.app.evaluate(
                () =>
                    (
                        globalThis as typeof globalThis & {
                            __caxriPathBrowserOpenDialogCalls?: number;
                        }
                    ).__caxriPathBrowserOpenDialogCalls,
            ),
        ).toBe(0);

        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect(
            running.page.getByRole('tab', { name: 'external-only.ts', exact: true }),
        ).toHaveCount(0);
        const reloaded = await pageRequest<{
            projects: Array<{ id: string }>;
            selectedSessionId?: string;
            sessions: Array<{ id: string }>;
        }>(running.page, 'app.bootstrap');
        expect({
            projectIds: reloaded.projects.map(({ id }) => id),
            selectedSessionId: reloaded.selectedSessionId,
            sessionIds: reloaded.sessions.map(({ id }) => id),
        }).toEqual(workspaceIdentity);
        expect(
            await running.app.evaluate(
                () =>
                    (
                        globalThis as typeof globalThis & {
                            __caxriPathBrowserOpenDialogCalls?: number;
                        }
                    ).__caxriPathBrowserOpenDialogCalls,
            ),
        ).toBe(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('typing a name that does not exist offers to create a file or folder', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-path-browser-create-e2e-'));
    const root = join(testDirectory, 'project');
    const userData = join(testDirectory, 'user-data');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);

        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await terminalInput.focus();
        await expect(terminalInput).toBeFocused();
        await running.page.keyboard.press('Meta+P');
        const dialog = running.page.getByRole('dialog');
        const input = dialog.getByRole('combobox', { name: 'File path' });
        await expect(input).toBeFocused();

        // Empty state used to be a dead end ("No matching file or folder."); it now offers to
        // create the typed name, a trailing slash meaning a folder. `notes.md` is a bare name, so
        // this also exercises the Project-wide search fallback — the Project is empty, so it finds
        // nothing and the create row is the only option in the list.
        await input.fill('notes.md');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        const fileCreateOption = dialog.getByRole('option', { name: /^Create file/ });
        await expect(dialog.getByRole('option')).toHaveCount(1);
        await expect(fileCreateOption).toBeVisible();
        await expect(fileCreateOption).toContainText('notes.md');
        // Selecting the create row is what turns the shared Enter hint into the create wording.
        await expect(dialog).toContainText('Enter Create');

        await input.press('Enter');
        await expect(dialog).toHaveCount(0);
        await expect(running.page.locator('.work-tab', { hasText: 'notes.md' })).toBeVisible();
        // Try/catch rather than a bare `readFile`: the create is asynchronous, so the first poll can
        // land before the file exists and an ENOENT rejection would fail the whole assertion
        // instead of retrying.
        await expect
            .poll(async () => {
                try {
                    return await readFile(join(root, 'notes.md'), 'utf8');
                } catch {
                    return;
                }
            })
            .toBe('');

        await running.page.evaluate(() => {
            const e2eBridge = (
                globalThis as typeof globalThis & {
                    caxriE2E: { armPathBrowserStartGate: () => void };
                }
            ).caxriE2E;
            e2eBridge.armPathBrowserStartGate();
        });
        await running.page.keyboard.press('Meta+P');
        await running.page.evaluate(() =>
            (
                globalThis as typeof globalThis & {
                    caxriE2E: { waitForPathBrowserStartGate: () => Promise<void> };
                }
            ).caxriE2E.waitForPathBrowserStartGate(),
        );
        const secondDialog = running.page.getByRole('dialog');
        const secondInput = secondDialog.getByRole('combobox', { name: 'File path' });
        await expect(secondInput).toBeFocused();
        await secondInput.fill('drafts/');
        await running.page.evaluate(() => {
            const e2eBridge = (
                globalThis as typeof globalThis & {
                    caxriE2E: { releasePathBrowserStartGate: () => void };
                }
            ).caxriE2E;
            e2eBridge.releasePathBrowserStartGate();
        });
        // A slow initial snapshot must not overwrite input entered while the dialog is opening.
        await expect(secondInput).toHaveValue('drafts/');
        await expect(secondInput).toHaveAttribute('aria-busy', 'false');
        const folderCreateOption = secondDialog.getByRole('option', { name: /^Create folder/ });
        await expect(folderCreateOption).toBeVisible();
        await expect(folderCreateOption).toContainText('drafts');
        await folderCreateOption.click();
        // Creating a folder navigates into it instead of closing the dialog, matching the folder
        // affordance in the existing entry list (`CornerDownLeft`/`ArrowRight`).
        await expect(secondDialog).toBeVisible();
        await expect(secondDialog).toContainText('drafts/');
        await expect(secondInput).toHaveValue('');
        await expect
            .poll(async () => {
                try {
                    const entry = await stat(join(root, 'drafts'));
                    return entry.isDirectory();
                } catch {
                    return false;
                }
            })
            .toBe(true);

        await secondInput.press('Escape');
        await expect(secondDialog).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
