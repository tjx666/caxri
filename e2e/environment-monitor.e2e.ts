import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings } from '@caxri/protocol';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri, pageRequest } from './support/helpers.ts';
import { openSettingsTab, revealSettingsSection } from './support/settings.ts';

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

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const settings = await openSettingsTab(running.page);
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
        await warning.click();
        const warningPopover = running.page.getByLabel('Environment monitoring warning');
        await expect(warningPopover).toContainText(
            `System time zone is ${actualTimeZone}; expected ${expectedTimeZone}.`,
        );
        await expect(warningPopover).toContainText(
            'example.com used Node B → Global; expected Node A.',
        );
        await expect(warningPopover.getByRole('button', { name: 'Check Now' })).toBeVisible();
        await expect(warningPopover.getByRole('button', { name: 'Use Current IP' })).toHaveCount(0);

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
