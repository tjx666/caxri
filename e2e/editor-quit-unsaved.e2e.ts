import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';

import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

const PROBE_GLOBAL = '__caxriE2EUnsavedDialogProbe';
const ORIGINAL = 'export const greeting = "hello";\n';

interface DialogSnapshot {
    buttons: string[];
    message: string;
    title?: string;
}

/**
 * Parks every native message box until the test answers it, so each prompt in the quit sequence is asserted in order.
 */
async function installDialogProbe(app: E2EApp): Promise<void> {
    await app.evaluate(({ dialog }, key) => {
        Reflect.deleteProperty(globalThis, key);
        dialog.showMessageBox = (windowOrOptions: unknown, maybeOptions?: MessageBoxOptions) => {
            const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
            return new Promise<MessageBoxReturnValue>((resolve) => {
                Reflect.set(globalThis, key, {
                    options,
                    respond: (response: number) => resolve({ response, checkboxChecked: false }),
                });
            });
        };
    }, PROBE_GLOBAL);
}

async function readDialog(app: E2EApp): Promise<DialogSnapshot | null> {
    return app.evaluate((_electron, key) => {
        const probe = Reflect.get(globalThis, key) as { options: MessageBoxOptions } | undefined;
        if (!probe) return null;
        return {
            buttons: [...(probe.options.buttons ?? [])],
            message: probe.options.message,
            title: probe.options.title,
        };
    }, PROBE_GLOBAL);
}

async function waitForDialog(app: E2EApp): Promise<DialogSnapshot> {
    await expect.poll(() => readDialog(app)).not.toBeNull();
    return (await readDialog(app))!;
}

async function answerDialog(app: E2EApp, response: number): Promise<void> {
    await app.evaluate(
        (_electron, input) => {
            const probe = Reflect.get(globalThis, input.key) as
                { respond(response: number): void } | undefined;
            if (!probe) throw new Error('No native dialog was pending');
            Reflect.deleteProperty(globalThis, input.key);
            // Let Playwright receive this result before an accepted answer tears down Electron's Main context.
            setImmediate(() => probe.respond(input.response));
        },
        { key: PROBE_GLOBAL, response },
    );
}

test('quitting or closing the window with an unsaved Editor buffer asks to save it first', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-quit-unsaved-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const filePath = join(root, 'greeting.ts');
    await mkdir(root, { recursive: true });
    await writeFile(filePath, ORIGINAL, 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: 'greeting.ts', exact: true }).dblclick();
        const tab = running.page.locator('.work-tab', { hasText: 'greeting.ts' });
        await expect(tab).toBeVisible();
        await running.page.locator('.monaco-editor').click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+ArrowDown');
        await running.page.keyboard.type('// unsaved edit\n');
        await expect(tab).toContainText('●');

        await installDialogProbe(running.app);
        await running.app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0]?.close();
        });
        expect(await waitForDialog(running.app)).toEqual({
            title: 'Unsaved Changes',
            message: "Save changes to 'greeting.ts' before closing the window?",
            buttons: ['Save', "Don't Save", 'Cancel'],
        });
        await answerDialog(running.app, 2);
        await expect(tab).toContainText('●');

        await installDialogProbe(running.app);
        await running.app.evaluate(({ app }) => app.quit());
        expect(await waitForDialog(running.app)).toEqual({
            title: 'Unsaved Changes',
            message: "Save changes to 'greeting.ts' before quitting?",
            buttons: ['Save', "Don't Save", 'Cancel'],
        });
        await answerDialog(running.app, 2);
        await expect(tab).toContainText('●');
        await expect(running.page.locator('.monaco-editor')).toContainText('// unsaved edit');
        expect(await readFile(filePath, 'utf8')).toBe(ORIGINAL);
        await running.page.screenshot({
            path: test.info().outputPath('quit-cancel-keeps-unsaved-buffer.png'),
            mask: [running.page.locator('.terminal-surface')],
        });

        await installDialogProbe(running.app);
        await running.app.evaluate(({ app }) => app.quit());
        expect(await waitForDialog(running.app)).toMatchObject({ title: 'Unsaved Changes' });
        await answerDialog(running.app, 0);
        await expect.poll(() => readFile(filePath, 'utf8')).toContain('// unsaved edit');
        // The idle shell Terminal still counts as a running task, so the existing quit prompt follows the save.
        expect(await waitForDialog(running.app)).toMatchObject({ title: 'Quit Caxri?' });
        const closed = running.app.waitForEvent('close');
        await answerDialog(running.app, 0);
        await closed;
    } finally {
        try {
            // Releases the desktop lease and Host even when the app already quit above.
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
