import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Principal } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../../domain-service';
import { isMobileGatewayMethodAllowedForRole } from '../../role-methods';
import { createMobilePreviewRequests } from '../requests';

const principal: Extract<Principal, { kind: 'paired-device' }> = {
    kind: 'paired-device',
    id: 'device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'control',
    projectIds: ['project-1'],
};

const domainService = {
    request: vi.fn(() => Promise.resolve({ roots: ['/work/app'] })),
} as unknown as ServerDomainService;

const createRequests = () =>
    createMobilePreviewRequests({
        random: (bytes) => new Uint8Array(bytes).fill(7),
        readListening: () =>
            Promise.resolve({
                sockets: [
                    { host: '127.0.0.1', pid: 11, port: 5173, processName: 'node' },
                    { host: '127.0.0.1', pid: 12, port: 7000, processName: 'ControlCenter' },
                ],
                workingDirectories: new Map([
                    [11, '/work/app/web'],
                    [12, '/'],
                ]),
            }),
        registry: { currentPrincipal: () => principal },
    });

describe('mobile preview requests', () => {
    it('is granted to control devices only', () => {
        for (const method of ['mobile.preview.list', 'mobile.preview.open']) {
            expect(isMobileGatewayMethodAllowedForRole('view', method)).toBe(false);
            expect(isMobileGatewayMethodAllowedForRole('reply', method)).toBe(false);
            expect(isMobileGatewayMethodAllowedForRole('control', method)).toBe(true);
        }
    });

    it("lists only the Session's listeners and re-checks the device after reading", async () => {
        const requests = createRequests();
        const reauthorize = vi.fn();
        const result = await requests.invoke(
            { method: 'mobile.preview.list', params: { sessionId: 'session-1' } },
            principal,
            domainService,
            () => '127.0.0.1',
            reauthorize,
        );
        expect(result).toEqual({ targets: [{ port: 5173, processName: 'node' }] });
        expect(reauthorize).toHaveBeenCalledOnce();
    });

    it('refuses to open a port outside the Session', async () => {
        const requests = createRequests();
        await expect(
            requests.invoke(
                { method: 'mobile.preview.open', params: { sessionId: 'session-1', port: 7000 } },
                principal,
                domainService,
                () => '127.0.0.1',
                () => {},
            ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await requests.clear();
    });

    it('matches a process whose working directory is the resolved form of a symlinked root', async () => {
        const base = await mkdtemp(path.join(tmpdir(), 'caxri-preview-'));
        try {
            const linked = path.join(base, 'linked');
            await symlink(await realpath(base), linked);
            const requests = createMobilePreviewRequests({
                random: (bytes) => new Uint8Array(bytes).fill(7),
                readListening: async () => ({
                    sockets: [{ host: '127.0.0.1', pid: 11, port: 3000, processName: 'node' }],
                    workingDirectories: new Map([[11, path.join(await realpath(base), 'web')]]),
                }),
                registry: { currentPrincipal: () => principal },
            });
            const result = await requests.invoke(
                { method: 'mobile.preview.list', params: { sessionId: 'session-1' } },
                principal,
                {
                    request: () => Promise.resolve({ roots: [linked] }),
                } as unknown as ServerDomainService,
                () => '127.0.0.1',
                () => {},
            );
            expect(result).toEqual({ targets: [{ port: 3000, processName: 'node' }] });
        } finally {
            await rm(base, { force: true, recursive: true });
        }
    });
});
