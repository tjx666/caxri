import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { E2EApp } from './support/electron-app.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { launchCaxri, pageRequest, runtimeStatus, waitForRuntimeReady } from './support/helpers.ts';

async function terminalCopyMenuItem(
    app: E2EApp,
): Promise<{ accelerator: string | null; label: string } | undefined> {
    return app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('command.terminal.copy');
        return item ? { accelerator: item.accelerator, label: item.label } : undefined;
    });
}

test('native menu preserves its keybinding hint across a failed read and Runtime recovery', async () => {
    allowE2EErrors([
        { source: 'host', event: 'host.runtime_exit', code: 'RUNTIME_EXIT', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-menu-keybinding-recovery-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);
    const running = await launchCaxri({
        env: { CAXRI_E2E_FAIL_MENU_KEYBINDINGS_GET_COPY_KEY: 'cmd+shift+c' },
        testRootPath: root,
        userDataDir: userData,
    });
    try {
        await expect
            .poll(() => terminalCopyMenuItem(running.app))
            .toEqual({ accelerator: null, label: 'Copy Selection [⌘C]' });

        const keybindings = await pageRequest<{
            value: Array<{ command: string; key: string; when?: 'terminalFocus' }>;
        }>(running.page, 'keybindings.get');
        const updated = keybindings.value.map((binding) =>
            binding.command === 'terminal.copy' ? { ...binding, key: 'cmd+shift+c' } : binding,
        );
        await pageRequest(running.page, 'keybindings.update', {
            source: JSON.stringify(updated, null, 2),
        });

        /**
         * The E2E-only one-shot fault matches this new key. Its failed refresh must leave the installed native menu
         * untouched even though the Runtime configuration event has already been consumed.
         */
        await expect
            .poll(() => terminalCopyMenuItem(running.app))
            .toEqual({ accelerator: null, label: 'Copy Selection [⌘C]' });
        await expect
            .poll(() =>
                running.app.evaluate(
                    () => process.env.CAXRI_E2E_MENU_KEYBINDINGS_GET_FAILURE_INJECTED,
                ),
            )
            .toBe('1');

        const serverStatus = await pageRequest<{ pid: number }>(running.page, 'host.status');
        process.kill(serverStatus.pid, 'SIGKILL');
        await expect(runtimeStatus(running.page)).toHaveAttribute(
            'data-runtime-status',
            'restarting',
        );
        await waitForRuntimeReady(running.page);

        await expect
            .poll(() => terminalCopyMenuItem(running.app))
            .toEqual({ accelerator: null, label: 'Copy Selection [⇧⌘C]' });
    } finally {
        try {
            await running.app.close();
        } catch {
            // The shared E2E error gate still owns teardown validation after an app-close failure.
        }
        await rm(testDirectory, { force: true, recursive: true });
    }
});
