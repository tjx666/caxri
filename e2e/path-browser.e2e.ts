import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    waitForRuntimeReady,
} from './support/helpers.ts';

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
        const rootListbox = dialog.getByRole('listbox', { name: 'Files in current directory' });
        const rootDirectoryOption = dialog.getByRole('option', { name: 'src' });
        await expect(rootDirectoryOption).toBeVisible();
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

        const editor = running.page.locator('.monaco-editor').first();
        await editor.click({ position: { x: 120, y: 24 } });
        await expect
            .poll(() => editor.evaluate((element) => element.contains(document.activeElement)))
            .toBe(true);
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
        await expect(dialog.getByRole('option', { name: 'src' })).toBeVisible();
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
    allowE2EErrors([
        { source: 'desktop', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
    ]);
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

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
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
        await expect(input).not.toHaveAttribute('aria-describedby', /.+/u);
        await expect(input).toHaveValue(projectRoot === '/' ? '/' : `${projectRoot}/`);
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
        // create the typed name, a trailing slash meaning a folder.
        await input.fill('notes.md');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await expect(dialog.getByRole('option')).toHaveCount(0);
        const fileCreateButton = dialog.getByRole('button', { name: 'Create file' });
        await expect(fileCreateButton).toBeVisible();
        await expect(fileCreateButton).toContainText('notes.md');
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
        const folderCreateButton = secondDialog.getByRole('button', { name: 'Create folder' });
        await expect(folderCreateButton).toBeVisible();
        await expect(folderCreateButton).toContainText('drafts');
        await folderCreateButton.click();
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
