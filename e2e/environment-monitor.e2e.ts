import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings } from '@caxri/protocol';

import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri, pageRequest } from './support/helpers.ts';
import { openSettingsPage, revealSettingsSection } from './support/settings.ts';

async function openEnvironmentFromCommandPalette(page: Page): Promise<void> {
    await page.keyboard.press('Meta+Shift+P');
    const palette = page.getByRole('dialog', { name: 'Command Palette' });
    await palette
        .getByPlaceholder('Search projects, sessions, and commands…')
        .fill('open environment');
    await palette.getByText('Open Environment', { exact: true }).click();
}

test('Environment monitoring keeps optional signals off and reports configured expectations', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-environment-monitor-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const controllerPaths: string[] = [];
    const controller = http.createServer((request, response) => {
        controllerPaths.push(request.url ?? '');
        response.setHeader('Content-Type', 'application/json');
        response.end(
            request.url === '/proxies'
                ? JSON.stringify({
                      proxies: {
                          'Global': { type: 'Selector' },
                          'Node A': { type: 'WireGuard' },
                          'Node B': { type: 'WireGuard' },
                      },
                  })
                : JSON.stringify({
                      connections: [
                          {
                              metadata: { host: 'example.com' },
                              chains: ['Node B', 'Global'],
                              start: '2026-10-28T02:00:00.000Z',
                          },
                      ],
                  }),
        );
    });
    await new Promise<void>((resolve) => controller.listen(0, '127.0.0.1', resolve));
    const controllerAddress = controller.address() as AddressInfo;
    const controllerEndpoint = `http://127.0.0.1:${controllerAddress.port}`;

    const running = await launchCaxri({
        env: { CAXRI_E2E_ENVIRONMENT_MONITOR_SCENARIO: 'changed' },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        const settings = await openSettingsPage(running.page);
        await revealSettingsSection(settings, 'Notifications');

        await expect(settings.getByRole('switch', { name: 'Public IP changes' })).toBeChecked();
        await expect(
            settings.getByRole('button', { name: 'Expected system time zone' }),
        ).toContainText('Off');
        const mihomoRoutes = settings.getByLabel('Mihomo route assertions');
        await expect(mihomoRoutes).toContainText(
            'Off. Add a domain route after loading nodes to start monitoring.',
        );

        await expect(
            pageRequest<{ nodes: string[] }>(running.page, 'environmentMonitor.mihomoNodes', {
                endpoint: controllerEndpoint,
                secret: null,
            }),
        ).resolves.toEqual({ nodes: ['Node A', 'Node B'] });
        await mihomoRoutes.getByLabel('Local Mihomo Controller').fill(controllerEndpoint);
        await mihomoRoutes.getByRole('button', { name: 'Load Nodes' }).click();
        await expect(mihomoRoutes.getByLabel('Expected Mihomo node')).toContainText('Node A');
        await expect
            .poll(async () => {
                const result = await pageRequest<{ value: AppSettings }>(
                    running.page,
                    'settings.get',
                );
                return result.value['environmentMonitor.mihomoRoutes'].endpoint;
            })
            .toBe(controllerEndpoint);
        await mihomoRoutes.getByLabel('Exact domain').fill('example.com');
        await mihomoRoutes.getByRole('button', { name: 'Add Route' }).click();

        await expect
            .poll(async () => {
                const result = await pageRequest<{ value: AppSettings }>(
                    running.page,
                    'settings.get',
                );
                return result.value['environmentMonitor.mihomoRoutes'];
            })
            .toMatchObject({
                endpoint: controllerEndpoint,
                assertions: [{ domain: 'example.com', expectedNode: 'Node A' }],
            });

        const actualTimeZone = await running.page.evaluate(
            () => new Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
        const expectedTimeZone =
            actualTimeZone === 'America/Los_Angeles' ? 'Asia/Shanghai' : 'America/Los_Angeles';
        await settings.getByRole('button', { name: 'Expected system time zone' }).click();
        await running.page.getByPlaceholder('Search time zones…').fill(expectedTimeZone);
        await running.page.getByRole('option', { name: expectedTimeZone, exact: true }).click();

        const warning = running.page.locator('[data-environment-monitor-state="warning"]');
        await expect(warning).toBeVisible({ timeout: 15_000 });
        await warning.hover();
        const warningTooltip = running.page.locator('.tooltip-popup');
        await expect(warningTooltip).toContainText(
            `System time zone is ${actualTimeZone}; expected ${expectedTimeZone}.`,
        );
        await expect(warningTooltip).toContainText(
            'example.com used Node B → Global; expected Node A.',
        );
        await warning.click();
        const environmentPage = running.page.locator('[data-environment-page]');
        await expect(environmentPage.getByRole('heading', { name: 'Environment' })).toBeVisible();
        await expect(environmentPage.getByText('203.0.113.11', { exact: true })).toBeVisible();
        await expect(environmentPage.getByText('Singapore', { exact: true })).toBeVisible();
        await expect(environmentPage.getByText('AS64511 · Example Hosting')).toBeVisible();
        await expect(environmentPage.getByText('Hosting', { exact: true }).first()).toBeVisible();
        await expect(
            environmentPage.getByText(/Third-party risk\s*65\/100/u).first(),
        ).toBeVisible();
        await expect(environmentPage.getByText('Anonymous', { exact: true }).first()).toBeVisible();
        await expect(environmentPage.getByText('United States', { exact: true })).toBeVisible();
        await expect(environmentPage.getByText('203.0.113.10', { exact: true })).toBeVisible();
        await expect(environmentPage.getByText('Current warnings')).toBeVisible();
        await expect(environmentPage.getByRole('button', { name: 'Check Now' })).toBeVisible();
        await expect(environmentPage.getByRole('button', { name: 'Use Current IP' })).toBeVisible();
        await running.page.mouse.move(0, 0);
        await warning.hover();
        await expect(warningTooltip).toContainText(
            'Public IP changed from 203.0.113.10 to 203.0.113.11.',
        );
        await environmentPage.getByRole('button', { name: 'Close Environment' }).click();
        await expect(environmentPage).toHaveCount(0);

        await openEnvironmentFromCommandPalette(running.page);
        await expect(environmentPage).toBeVisible();
        await expect(environmentPage).toHaveCount(1);

        expect(controllerPaths.length).toBeGreaterThan(1);
        expect(
            controllerPaths.every((path) => path === '/proxies' || path === '/connections'),
        ).toBe(true);
    } finally {
        await running.app.close();
        await new Promise<void>((resolve, reject) =>
            controller.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(testDirectory, { force: true, recursive: true });
    }
});

test('Environment monitoring keeps public IP change evidence when profile context is unavailable', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-environment-monitor-failure-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({
        env: { CAXRI_E2E_ENVIRONMENT_MONITOR_SCENARIO: 'changed-profile-unavailable' },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await openEnvironmentFromCommandPalette(running.page);
        const environmentPage = running.page.locator('[data-environment-page]');
        await expect(environmentPage.getByText('203.0.113.11', { exact: true })).toBeVisible();
        await expect(
            environmentPage.getByText(
                'checkip.me context is unavailable. Public IP monitoring continues.',
                { exact: true },
            ),
        ).toBeVisible();

        const warning = running.page.locator('[data-environment-monitor-state="warning"]');
        await expect(warning).toBeVisible();
        await warning.hover();
        await expect(running.page.locator('.tooltip-popup')).toContainText(
            'Public IP changed from 203.0.113.10 to 203.0.113.11.',
        );
    } finally {
        await running.app.close();
        await rm(testDirectory, { force: true, recursive: true });
    }
});
