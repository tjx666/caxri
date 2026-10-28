import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { EnvironmentMonitorMihomoSettings } from '@caxri/protocol';
import { MAX_MIHOMO_CONTROLLER_NODES } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    parseMihomoConnections,
    parseMihomoNodes,
    readMihomoConnections,
    readMihomoNodes,
} from '../environment-monitor/mihomo-controller';

async function withController(
    handle: http.RequestListener,
    run: (endpoint: string) => Promise<void>,
): Promise<void> {
    const server = http.createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address() as AddressInfo;
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
}

describe('Mihomo Controller projections', () => {
    it('lists only selectable leaf nodes', () => {
        expect(
            parseMihomoNodes({
                proxies: {
                    'DIRECT': { type: 'Direct' },
                    'Global': { type: 'Selector' },
                    'Automatic': { type: 'URLTest' },
                    'Node B': { type: 'Shadowsocks' },
                    'Node A': { type: 'WireGuard' },
                },
            }),
        ).toEqual(['Node A', 'Node B']);
    });

    it('bounds the selectable node list', () => {
        const proxies = Object.fromEntries(
            Array.from({ length: MAX_MIHOMO_CONTROLLER_NODES + 1 }, (_, index) => [
                `Node ${String(index).padStart(4, '0')}`,
                { type: 'WireGuard' },
            ]),
        );

        expect(parseMihomoNodes({ proxies })).toHaveLength(MAX_MIHOMO_CONTROLLER_NODES);
    });

    it('projects only bounded host and chain metadata from live connections', () => {
        expect(
            parseMihomoConnections(
                {
                    connections: [
                        {
                            metadata: { host: 'EXAMPLE.COM.' },
                            chains: ['Node A', 'Global'],
                            start: '2026-10-28T02:00:00.000Z',
                        },
                        { metadata: { host: '' }, chains: ['DIRECT'] },
                        { metadata: { host: 'ignored.example' }, chains: [] },
                    ],
                },
                123,
            ),
        ).toEqual([
            {
                host: 'example.com',
                chains: ['Node A', 'Global'],
                startedAt: Date.parse('2026-10-28T02:00:00.000Z'),
            },
        ]);
    });

    it('reads only fixed Controller endpoints with the configured bearer secret', async () => {
        const requests: Array<{ authorization: string | undefined; path: string | undefined }> = [];
        await withController(
            (request, response) => {
                requests.push({
                    authorization: request.headers.authorization,
                    path: request.url,
                });
                response.setHeader('Content-Type', 'application/json');
                response.end(
                    request.url === '/proxies'
                        ? JSON.stringify({
                              proxies: {
                                  'Global': { type: 'Selector' },
                                  'Node A': { type: 'WireGuard' },
                              },
                          })
                        : JSON.stringify({
                              connections: [
                                  {
                                      metadata: { host: 'example.com' },
                                      chains: ['Node A', 'Global'],
                                      start: '2026-10-28T02:00:00.000Z',
                                  },
                              ],
                          }),
                );
            },
            async (endpoint) => {
                const settings: EnvironmentMonitorMihomoSettings = {
                    endpoint,
                    secret: 'local-secret',
                    assertions: [{ domain: 'example.com', expectedNode: 'Node A' }],
                };
                await expect(readMihomoNodes(settings)).resolves.toEqual(['Node A']);
                await expect(readMihomoConnections(settings, 0)).resolves.toEqual([
                    {
                        host: 'example.com',
                        chains: ['Node A', 'Global'],
                        startedAt: Date.parse('2026-10-28T02:00:00.000Z'),
                    },
                ]);
            },
        );

        expect(requests).toEqual([
            { authorization: 'Bearer local-secret', path: '/proxies' },
            { authorization: 'Bearer local-secret', path: '/connections' },
        ]);
    });

    it('rejects an interrupted Controller response without leaving the read pending', async () => {
        await withController(
            (_request, response) => {
                response.write('{"proxies":');
                response.destroy();
            },
            async (endpoint) => {
                await expect(
                    readMihomoNodes({ endpoint, secret: null, assertions: [] }),
                ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
            },
        );
    });
});
