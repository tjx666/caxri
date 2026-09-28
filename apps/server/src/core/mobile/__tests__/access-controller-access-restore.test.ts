import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandExecutionContext, MobileAccessStatus } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import type { ServerDomainService } from '../../domain-service';
import { openMobileAccessController } from '../access-controller';

const temporaryDirectories: string[] = [];
const terminalExecution = {
    onObserverEvent: () => () => {},
    onHostExit: () => () => {},
} as unknown as TerminalExecutionPort;
const domainService = {} as ServerDomainService;
const context = {
    capabilities: [],
    principal: { kind: 'owner', id: 'owner' },
} as unknown as CommandExecutionContext;

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('MobileAccessController remembered access switch', () => {
    it('reopens the gateway on the next start only while the owner left access on', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-restore-'));
        temporaryDirectories.push(directory);
        const registryPath = join(directory, 'mobile-devices.json');
        const start = async () => {
            const controller = await openMobileAccessController({
                directory,
                registryPath,
                selectAddress: () => '127.0.0.1',
            });
            controller.attach(
                { invoke: vi.fn() },
                'b'.repeat(32),
                { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
                domainService,
                terminalExecution,
                () => {},
            );
            const isEnabled = async () =>
                (
                    (await controller.invokeControl(
                        { method: 'mobile.access.status', params: {} },
                        context,
                        domainService,
                    )) as MobileAccessStatus
                ).enabled;
            return { controller, isEnabled };
        };

        const first = await start();
        expect(await first.isEnabled()).toBe(false);
        await first.controller.invokeControl(
            { method: 'mobile.access.enable', params: {} },
            context,
            domainService,
        );
        await first.controller.close();
        expect(JSON.parse(await readFile(registryPath, 'utf8'))).toMatchObject({
            accessEnabled: true,
        });

        const second = await start();
        await vi.waitFor(async () => expect(await second.isEnabled()).toBe(true));
        await second.controller.invokeControl(
            { method: 'mobile.access.disable', params: {} },
            context,
            domainService,
        );
        await second.controller.close();

        // The next start reads this flag; `access-persistence.test.ts` covers that a cleared flag never reopens.
        const store = JSON.parse(await readFile(registryPath, 'utf8')) as Record<string, unknown>;
        expect(store).not.toHaveProperty('accessEnabled');
    });
});
