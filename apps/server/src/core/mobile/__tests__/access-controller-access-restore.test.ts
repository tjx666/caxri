import type { CommandExecutionContext, MobileAccessStatus } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import { createMemoryMobileDeviceStore } from '../../__tests__/credential-stores.fixture';
import type { ServerDomainService } from '../../domain-service';
import { openMobileAccessController } from '../access-controller';

const terminalExecution = {
    onObserverEvent: () => () => {},
    onHostExit: () => () => {},
} as unknown as TerminalExecutionPort;
const domainService = {} as ServerDomainService;
const context = {
    capabilities: [],
    principal: { kind: 'owner', id: 'owner' },
} as unknown as CommandExecutionContext;

describe('MobileAccessController remembered access switch', () => {
    it('reopens the gateway on the next start only while the owner left access on', async () => {
        const store = createMemoryMobileDeviceStore();
        const start = () => {
            const controller = openMobileAccessController({
                store,
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

        const first = start();
        expect(await first.isEnabled()).toBe(false);
        await first.controller.invokeControl(
            { method: 'mobile.access.enable', params: {} },
            context,
            domainService,
        );
        await first.controller.close();
        expect(store.preferences).toMatchObject({ accessEnabled: true });

        const second = start();
        await vi.waitFor(async () => expect(await second.isEnabled()).toBe(true));
        await second.controller.invokeControl(
            { method: 'mobile.access.disable', params: {} },
            context,
            domainService,
        );
        await second.controller.close();

        // The next start reads this flag; `access-persistence.test.ts` covers that a cleared flag never reopens.
        expect(store.preferences).not.toHaveProperty('accessEnabled');
    });
});
