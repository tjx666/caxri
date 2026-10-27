import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EnvironmentMonitorState } from '@caxri/protocol';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri, pageRequest } from './support/helpers.ts';
import { openSettingsTab, revealSettingsSection } from './support/settings.ts';

test('Environment monitor keeps a public IP change visible until the user accepts it', async ({
    e2eErrorGate,
}, testInfo) => {
    void e2eErrorGate;
    const directory = await mkdtemp(join(tmpdir(), 'caxri-environment-monitor-e2e-'));
    const root = join(directory, 'project');
    const fixture = join(directory, 'environment.json');
    await mkdir(root, { recursive: true });
    const injectReading = async (ip: string): Promise<void> => {
        const staging = `${fixture}.tmp`;
        await writeFile(staging, JSON.stringify({ ip }), 'utf8');
        await rename(staging, fixture);
    };
    await injectReading('192.0.2.10');
    const running = await launchCaxri({
        userDataDir: join(directory, 'user-data'),
        testRootPath: root,
        env: { CAXRI_E2E_ENVIRONMENT_MONITOR_FIXTURE: fixture },
        windowMode: 'visible',
    });
    try {
        const { page } = running;
        await expect
            .poll(
                async () =>
                    (await pageRequest<EnvironmentMonitorState>(page, 'environmentMonitor.read'))
                        .state,
            )
            .toBe('healthy');
        await expect(page.locator('[data-environment-monitor-state]')).toHaveCount(0);
        const settings = await openSettingsTab(page);
        await revealSettingsSection(settings, 'Notifications');
        await expect(settings.getByRole('switch', { name: 'Public IP changes' })).toBeChecked();
        await Promise.all(
            [
                'Local proxy interruptions',
                'Network location changes',
                'Network time-zone mismatch',
                'Environment check unavailable',
            ].map((name) => expect(settings.getByRole('switch', { name })).not.toBeChecked()),
        );

        await injectReading('198.51.100.20');
        const warning = await pageRequest<EnvironmentMonitorState>(
            page,
            'environmentMonitor.refresh',
        );
        expect(warning.state).toBe('warning');
        expect(warning.issues).toEqual(['publicIpChanged']);
        expect(warning.details).toBeUndefined();

        // Reload only the Renderer so its first query reads Main's retained warning immediately.
        await page.reload();
        const chip = page.locator('[data-environment-monitor-state="warning"]');
        await expect(chip).toBeVisible();
        await expect(chip).toHaveText('Environment · 1');
        await chip.click();
        const details = page.getByLabel('Environment monitor details');
        await expect(details).toContainText('The public IP changed');
        await expect(details).toContainText(
            'Only signals enabled in Settings are reported. Caxri does not change network settings.',
        );
        await expect(details).not.toContainText('192.0.2.10');
        await expect(details).not.toContainText('198.51.100.20');
        await page.screenshot({ path: testInfo.outputPath('environment-monitor-warning.png') });

        await details.getByRole('button', { name: 'Use current environment' }).click();
        await expect(page.locator('[data-environment-monitor-state]')).toHaveCount(0);
        const accepted = await pageRequest<EnvironmentMonitorState>(
            page,
            'environmentMonitor.read',
        );
        expect(accepted.state).toBe('healthy');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});
