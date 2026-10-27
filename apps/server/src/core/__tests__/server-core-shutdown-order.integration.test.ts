import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestProtocolRecoveryState } from '../../__tests__/support/protocol-recovery';
import type { DomainHandlers } from '../../domains/domain-services';
import * as extensionServiceFactory from '../extensions/create-service';
import type { ServerCore } from '../server-core';
import { startServerCore } from '../server-core';
import { createMemoryCredentialStores } from './credential-stores.fixture';

function fixtureHandlers(overrides: Partial<DomainHandlers>): DomainHandlers {
    return overrides as DomainHandlers;
}

const apps: ServerCore[] = [];
const directories: string[] = [];

afterEach(async () => {
    const appsToStop = apps.slice();
    apps.length = 0;
    await Promise.all(appsToStop.map((app) => app.stop('test-cleanup')));

    const directoriesToRemove = directories.slice();
    directories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('Server Core application', () => {
    it('captures Terminal snapshots via domainService.shutdown before extension host teardown', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-shutdown-order-'));
        directories.push(userDataPath);
        const order: string[] = [];
        const record = (label: string) => (): Promise<void> => {
            order.push(label);
            return Promise.resolve();
        };
        vi.spyOn(extensionServiceFactory, 'createExtensionService').mockResolvedValue({
            activeContextChanged: vi.fn(),
            markCoreStopping: vi.fn(() => order.push('extensionService.markCoreStopping')),
            shutdown: vi.fn(record('extensionService.shutdown')),
        } as never);
        const app = await startServerCore({
            commit: 'test',
            createDomainServices: () =>
                Promise.resolve({
                    close: record('domainService.shutdown'),
                    handlers: fixtureHandlers({}),
                    credentials: createMemoryCredentialStores(),
                    protocolRecovery: createTestProtocolRecoveryState(),
                    validateRequestContext: () => {},
                }),
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);
        await app.stop('test-shutdown-order');

        // Extension Host teardown can block up to 5s; Terminal snapshot capture must not wait behind it (see `stop()`).
        // The Extension Host is marked first so a signal that kills it during that wait is not restarted as a crash.
        expect(order).toEqual([
            'extensionService.markCoreStopping',
            'domainService.shutdown',
            'extensionService.shutdown',
        ]);
    });
});
