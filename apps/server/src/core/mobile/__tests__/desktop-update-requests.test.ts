import type { DesktopOperation, UpdateState } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ServerDesktopRouter } from '../../desktop-router';
import type { ServerDomainService } from '../../domain-service';
import { invokeMobileDesktopUpdateRequest } from '../desktop-update-requests';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';

const ready: UpdateState = {
    status: 'ready',
    currentVersion: '0.0.3',
    version: '0.0.4',
    fileName: 'Caxri-0.0.4-arm64.dmg',
    installMode: 'restart',
};

function domainService(
    pending: Promise<{ count: number }> = Promise.resolve({ count: 2 }),
    request = vi.fn(),
) {
    return {
        request: request.mockImplementation((method: string) => {
            if (method === 'terminal.runningCount')
                return Promise.resolve({ terminals: 1, chats: 3 });
            if (method === 'gitReview.pending') return pending;
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        }),
    } as unknown as ServerDomainService;
}

function router(answer: unknown, operations: DesktopOperation[] = [], isAttached = true) {
    return new ServerDesktopRouter({
        bridge: {
            lease: () =>
                isAttached
                    ? { desktopId: 'desktop-1', generation: 2, expiresAt: Date.now() + 1_000 }
                    : undefined,
            invoke: (operation) => {
                operations.push(operation);
                return Promise.resolve(answer);
            },
        },
        domainService: domainService(),
    });
}

describe('mobile.desktopUpdate', () => {
    it('adds what the restart ends to a staged update', async () => {
        const operations: DesktopOperation[] = [];

        await expect(
            invokeMobileDesktopUpdateRequest(
                { method: 'mobile.desktopUpdate.read', params: {} },
                router(ready, operations),
                domainService(),
            ),
        ).resolves.toEqual({
            desktop: 'online',
            state: ready,
            impact: { terminals: 1, chats: 3, pendingReviewComments: 2 },
        });
        expect(operations).toEqual([{ kind: 'update', action: 'read' }]);
    });

    it('still shows the restart when review comments cannot be read', async () => {
        const unreadable = domainService(Promise.reject(new Error('offline')));
        await expect(
            invokeMobileDesktopUpdateRequest(
                { method: 'mobile.desktopUpdate.read', params: {} },
                router(ready),
                unreadable,
            ),
        ).resolves.toMatchObject({ impact: { pendingReviewComments: 0 } });
    });

    it('asks Desktop to check or download without reading the impact first', async () => {
        const operations: DesktopOperation[] = [];
        const checking: UpdateState = { status: 'checking', currentVersion: '0.0.3' };
        const request = vi.fn();
        const services = domainService(undefined, request);

        await invokeMobileDesktopUpdateRequest(
            { method: 'mobile.desktopUpdate.read', params: { check: true } },
            router(checking, operations),
            services,
        );
        await invokeMobileDesktopUpdateRequest(
            { method: 'mobile.desktopUpdate.download', params: {} },
            router(checking, operations),
            services,
        );

        expect(operations.map((operation) => 'action' in operation && operation.action)).toEqual([
            'check',
            'download',
        ]);
        expect(request).not.toHaveBeenCalled();
    });

    it('answers offline without a Desktop and unsupported for an SSH Host window', async () => {
        await expect(
            invokeMobileDesktopUpdateRequest(
                { method: 'mobile.desktopUpdate.read', params: {} },
                router(ready, [], false),
                domainService(),
            ),
        ).resolves.toEqual({ desktop: 'offline' });
        await expect(
            invokeMobileDesktopUpdateRequest(
                { method: 'mobile.desktopUpdate.install', params: { version: '0.0.4' } },
                router({ unsupported: true }),
                domainService(),
            ),
        ).resolves.toEqual({ outcome: 'blocked', reason: 'unsupported' });
        await expect(
            invokeMobileDesktopUpdateRequest(
                { method: 'mobile.desktopUpdate.install', params: { version: '0.0.4' } },
                undefined,
                domainService(),
            ),
        ).resolves.toEqual({ outcome: 'blocked', reason: 'desktop-offline' });
    });

    it('relays the confirmed version and rejects a malformed Desktop answer', async () => {
        const operations: DesktopOperation[] = [];

        await expect(
            invokeMobileDesktopUpdateRequest(
                { method: 'mobile.desktopUpdate.install', params: { version: '0.0.4' } },
                router({ outcome: 'restarting', version: '0.0.4' }, operations),
                domainService(),
            ),
        ).resolves.toEqual({ outcome: 'restarting', version: '0.0.4' });
        expect(operations).toEqual([{ kind: 'update', action: 'install', version: '0.0.4' }]);
        await expect(
            invokeMobileDesktopUpdateRequest(
                { method: 'mobile.desktopUpdate.install', params: { version: '0.0.4' } },
                router({ outcome: 'done' }),
                domainService(),
            ),
        ).rejects.toMatchObject({ code: 'INTERNAL' });
    });

    it('is granted only to control devices', () => {
        for (const method of [
            'mobile.desktopUpdate.read',
            'mobile.desktopUpdate.download',
            'mobile.desktopUpdate.install',
        ]) {
            expect(isMobileGatewayMethodAllowedForRole('control', method)).toBe(true);
            expect(isMobileGatewayMethodAllowedForRole('reply', method)).toBe(false);
            expect(isMobileGatewayMethodAllowedForRole('view', method)).toBe(false);
        }
    });
});
