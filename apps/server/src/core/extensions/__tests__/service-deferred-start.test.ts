import { StructuredLogger } from '@caxri/system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExtensionHostStartGate } from '../host-start-gate';
import {
    observationIdentity,
    resetSupervisorHarness,
    supervisorHarness,
    supervisorModule,
} from './service-harness.fixture';

vi.mock('../catalog', async () => (await import('./service-harness.fixture')).catalogModule);
vi.mock('../discovery', async () => (await import('./service-harness.fixture')).discoveryModule);
vi.mock('../supervisor', async () => (await import('./service-harness.fixture')).supervisorModule);

import { ExtensionService } from '../service';

const context = {
    kind: 'session' as const,
    sessionId: 'session-1',
    workbenchProjectId: 'project-1',
};

function createService(): ExtensionService {
    return new ExtensionService({
        ...observationIdentity,
        appVersion: '0.0.17',
        commit: 'test',
        extensionHostPath: '/out/main/extension-host.js',
        extensionRoots: ['/extensions'],
        includeTestOnly: true,
        logger: new StructuredLogger('/tmp/caxri-extension-deferred-test', 'server-core', 'error'),
        activeContext: () =>
            Promise.resolve({
                ownerProjectId: 'project-1',
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
            }),
        projectIds: () => Promise.resolve(['project-1']),
        projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
        workspaceRequest: () => Promise.resolve(null),
    });
}

describe('ExtensionService deferred Extension Host start', () => {
    beforeEach(() => {
        resetSupervisorHarness();
        vi.restoreAllMocks();
    });

    it('starts the Host eagerly by default', async () => {
        const start = vi.spyOn(supervisorModule.ExtensionHostSupervisor.prototype, 'start');
        await createService().start();
        expect(start).toHaveBeenCalledOnce();
    });

    it('publishes the catalog without forking the Host and drops notifications until it starts', async () => {
        const start = vi.spyOn(supervisorModule.ExtensionHostSupervisor.prototype, 'start');
        const service = createService();
        await service.start({ deferHost: true });
        expect(service.catalog().views.map(({ id }) => id)).toContain('publisher.fixture.tree');
        await service.activeContextChanged(context);
        await service.gitChanged(context);
        await service.projectStatusChanged(context);
        expect(await service.cancel('request-1')).toEqual({ cancelled: false });
        expect(start).not.toHaveBeenCalled();
        expect(supervisorHarness.requests).toEqual([]);

        await Promise.all([
            service.startHost('desktop-attached'),
            service.startHost('desktop-attached'),
        ]);
        expect(start).toHaveBeenCalledOnce();
        await service.gitChanged(context);
        expect(supervisorHarness.requests.map(({ method }) => method)).toEqual(['gitChanged']);
    });

    it('lets the first view request reach the Host when no client start happened', async () => {
        const service = createService();
        await service.start({ deferHost: true });
        supervisorHarness.activation.resolve();
        await service.treeChildren({
            viewId: 'publisher.fixture.tree',
            requestId: 'tree-1',
            context,
        });
        await service.activeContextChanged(context);
        expect(supervisorHarness.requests.map(({ method }) => method)).toEqual([
            'activate',
            'treeChildren',
            'activeContextChanged',
        ]);
    });

    it('does not start the Host once Server Core is stopping', async () => {
        const start = vi.spyOn(supervisorModule.ExtensionHostSupervisor.prototype, 'start');
        const service = createService();
        await service.start({ deferHost: true });
        service.markCoreStopping();
        await service.startHost('desktop-attached');
        expect(start).not.toHaveBeenCalled();
    });
});

describe('ExtensionHostStartGate', () => {
    it('records the first trigger for the first ready and restart afterwards', async () => {
        const gate = new ExtensionHostStartGate();
        expect(gate.hasStarted).toBe(false);
        const startHost = vi.fn(() => Promise.resolve());
        await gate.start('desktop-attached', startHost);
        await gate.start('core-start', startHost);
        expect(startHost).toHaveBeenCalledOnce();
        expect(gate.hasStarted).toBe(true);
        expect(gate.takeReadyTrigger()).toBe('desktop-attached');
        expect(gate.takeReadyTrigger()).toBe('restart');
    });

    it('attributes a Host started by a request', () => {
        const gate = new ExtensionHostStartGate();
        gate.markRequested();
        expect(gate.hasStarted).toBe(true);
        expect(gate.takeReadyTrigger()).toBe('request');
    });
});
