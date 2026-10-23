import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageBoxOptions, MessageBoxReturnValue, SaveDialogOptions } from 'electron';

import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

const PROBE_GLOBAL = '__caxriE2EUntitledDialogProbe';
const SUGGESTION_GLOBAL = '__caxriE2EUntitledSaveSuggestion';

/**
 * Parks every native message box until the test answers it, and answers Save As with `savePath`. The suggested path is
 * kept in a Main global; the quit that follows the save waits on the running-task prompt, so the test can still read
 * it.
 */
async function installDialogProbes(app: E2EApp, savePath: string): Promise<void> {
    await app.evaluate(
        ({ dialog }, input) => {
            Reflect.deleteProperty(globalThis, input.key);
            dialog.showMessageBox = (
                windowOrOptions: unknown,
                maybeOptions?: MessageBoxOptions,
            ) => {
                const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
                return new Promise<MessageBoxReturnValue>((resolve) => {
                    Reflect.set(globalThis, input.key, {
                        options,
                        respond: (response: number) =>
                            resolve({ response, checkboxChecked: false }),
                    });
                });
            };
            dialog.showSaveDialog = (
                windowOrOptions: unknown,
                maybeOptions?: SaveDialogOptions,
            ) => {
                const options = maybeOptions ?? (windowOrOptions as SaveDialogOptions);
                Reflect.set(globalThis, input.suggestionKey, options.defaultPath);
                return Promise.resolve({ canceled: false, filePath: input.savePath });
            };
        },
        { key: PROBE_GLOBAL, savePath, suggestionKey: SUGGESTION_GLOBAL },
    );
}

async function readTextIfPresent(path: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch {
        return '';
    }
}

async function readDialogMessage(app: E2EApp): Promise<string | null> {
    return app.evaluate((_electron, key) => {
        const probe = Reflect.get(globalThis, key) as { options: MessageBoxOptions } | undefined;
        return probe ? probe.options.message : null;
    }, PROBE_GLOBAL);
}

async function readDialogTitle(app: E2EApp): Promise<string | undefined> {
    await expect.poll(() => readDialogMessage(app)).not.toBeNull();
    return app.evaluate((_electron, key) => {
        const probe = Reflect.get(globalThis, key) as { options: MessageBoxOptions } | undefined;
        return probe?.options.title;
    }, PROBE_GLOBAL);
}

async function waitForDialogMessage(app: E2EApp): Promise<string> {
    await expect.poll(() => readDialogMessage(app)).not.toBeNull();
    return (await readDialogMessage(app))!;
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

test('an untitled editor asks to save when closed or on quit, and saves through Save As', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-untitled-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const savePath = join(root, 'scratch.txt');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await running.page.keyboard.press('Meta+Alt+n');
        const tab = running.page.locator('.work-tab', { hasText: 'Untitled-1' });
        await expect(tab).toBeVisible();
        await running.page.keyboard.type('scratch notes\nsecond line');
        const named = running.page.locator('.work-tab', { hasText: 'scratch notes' });
        await expect(named).toContainText('●');

        await installDialogProbes(running.app, savePath);
        await running.page.keyboard.press('Meta+w');
        expect(await waitForDialogMessage(running.app)).toBe(
            "Do you want to save the changes you made to 'scratch notes'?",
        );
        await answerDialog(running.app, 2);
        await expect(named).toBeVisible();
        await running.page.screenshot({
            path: test.info().outputPath('untitled-kept-after-cancel.png'),
            mask: [running.page.locator('.terminal-surface')],
        });

        await running.app.evaluate(({ app }) => app.quit());
        expect(await waitForDialogMessage(running.app)).toBe(
            "Save changes to 'scratch notes' before quitting?",
        );
        await answerDialog(running.app, 0);
        await expect.poll(() => readTextIfPresent(savePath)).toBe('scratch notes\nsecond line');
        // Projects are stored by their resolved path, so the suggestion sits under `/private/var` on macOS.
        expect(
            await running.app.evaluate(
                (_electron, key) => Reflect.get(globalThis, key) as string | undefined,
                SUGGESTION_GLOBAL,
            ),
        ).toBe(join(await realpath(root), 'scratch notes'));
        // The idle shell Terminal still counts as a running task, so the existing quit prompt follows the save.
        expect(await readDialogTitle(running.app)).toBe('Quit Caxri?');
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
