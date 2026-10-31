import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri, pageRequest } from './support/helpers.ts';
import {
    openSettingsPage,
    openSettingsSection,
    revealSettingsSection,
} from './support/settings.ts';

test('Mobile Access loading spinner stops when reduced motion is enabled', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-spinner-motion-'));
    const root = join(testDirectory, 'project');
    await mkdir(root);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'profile'),
        testRootPath: root,
    });
    let serverPid: number | undefined;

    try {
        const settingsTab = await openSettingsPage(running.page);
        await revealSettingsSection(settingsTab, 'Mobile');
        await expect(settingsTab.getByTestId('mobile-access-form')).toBeVisible();
        // Leave the Settings section so the Mobile Access form unmounts. Closing the Settings page would not: the page
        // stays mounted while hidden (issue caxri#2369).
        await openSettingsSection(settingsTab, 'Keybindings');
        await expect(settingsTab.getByTestId('mobile-access-form')).toHaveCount(0);
        serverPid = (await pageRequest<{ pid: number }>(running.page, 'host.status')).pid;
        // Freeze only the isolated Server after Settings has bootstrapped, keeping the remounted form in loading state.
        process.kill(serverPid, 'SIGSTOP');
        await revealSettingsSection(settingsTab, 'Mobile');
        const loading = settingsTab.locator('[role="status"]', {
            hasText: 'Loading mobile access…',
        });
        const spinner = loading.locator('[data-slot="spinner"]');
        await expect(spinner).toBeVisible();

        await running.page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect
            .poll(() => spinner.evaluate((element) => getComputedStyle(element).animationName))
            .not.toBe('none');
        await loading.screenshot({ path: test.info().outputPath('mobile-access-motion-on.png') });

        await running.page.emulateMedia({ reducedMotion: 'reduce' });
        await expect
            .poll(() => spinner.evaluate((element) => getComputedStyle(element).animationName))
            .toBe('none');
        await loading.screenshot({
            path: test.info().outputPath('mobile-access-motion-reduced.png'),
        });
    } finally {
        if (serverPid !== undefined) {
            try {
                process.kill(serverPid, 'SIGCONT');
            } catch {
                // The Server may have already exited during a failed launch.
            }
        }
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
