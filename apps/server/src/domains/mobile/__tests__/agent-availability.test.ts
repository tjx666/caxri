import { defaultAppSettings, mobileMethods } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ConfigService } from '../../config';
import type { CaxriDatabase } from '../../db';
import {
    createAgentAvailabilityHandler,
    createMobileAgentAvailabilityHandler,
} from '../agent-availability';

describe('mobile Agent availability', () => {
    it('checks Project grants before probing and returns only availability, never executable paths', async () => {
        const discover = vi.fn((provider: string) =>
            Promise.resolve(provider === 'codex' ? '/fixture/bin/codex' : undefined),
        );
        const handler = createMobileAgentAvailabilityHandler({
            configuration: {
                getSettings: () => ({ value: defaultAppSettings }),
            } as unknown as ConfigService,
            database: {
                listVisibleProjects: () => [{ id: 'project-1' }],
            } as unknown as CaxriDatabase,
            discover,
        });
        const principal = {
            kind: 'paired-device' as const,
            id: 'paired-device:device-1',
            deviceId: 'device-1',
            generation: 1,
            role: 'control' as const,
            projectIds: ['project-1'],
        };
        await expect(handler({ projectId: 'project-other', principal })).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        expect(discover).not.toHaveBeenCalled();
        const result = await handler({ projectId: 'project-1', principal });
        expect(result.agents).toEqual([
            { kind: 'claude', available: false, reason: 'Agent CLI is unavailable' },
            { kind: 'codex', available: true },
            { kind: 'grok', available: false, reason: 'Agent CLI is unavailable' },
            { kind: 'antigravity', available: false, reason: 'Agent CLI is unavailable' },
            { kind: 'shell', available: true },
        ]);
        expect(result.openAgentsInChat).toBe(true);
        expect(mobileMethods['mobile.agent.availability'].result.safeParse(result).success).toBe(
            true,
        );
        expect(JSON.stringify(result)).not.toContain('/fixture/bin');
    });

    it("reports the Mac's Open Agents in Chat setting as the new Session default", async () => {
        const handler = createMobileAgentAvailabilityHandler({
            configuration: {
                getSettings: () => ({
                    value: { ...defaultAppSettings, 'session.openAgentsInChat': true },
                }),
            } as unknown as ConfigService,
            database: {
                listVisibleProjects: () => [{ id: 'project-1' }],
            } as unknown as CaxriDatabase,
            discover: () => Promise.resolve(undefined),
        });
        const result = await handler({
            projectId: 'project-1',
            principal: {
                kind: 'paired-device',
                id: 'paired-device:device-1',
                deviceId: 'device-1',
                generation: 1,
                role: 'control',
                projectIds: ['project-1'],
            },
        });
        expect(result.openAgentsInChat).toBe(true);
    });
});

describe('desktop Agent availability', () => {
    it('reports each provider from its configured executable without returning a path', async () => {
        const discover = vi.fn((provider: string) =>
            Promise.resolve(provider === 'codex' ? '/fixture/bin/codex' : undefined),
        );
        const handler = createAgentAvailabilityHandler({
            configuration: {
                getSettings: () => ({ value: defaultAppSettings }),
            } as unknown as ConfigService,
            discover,
            signIn: { read: () => Promise.resolve('signedIn') },
        });
        const result = await handler();
        expect(result.providers).toEqual([
            { kind: 'claude', available: false },
            { kind: 'codex', available: true },
            { kind: 'grok', available: false },
            { kind: 'antigravity', available: false },
        ]);
        expect(JSON.stringify(result)).not.toContain('/fixture/bin');
    });

    it('marks an installed Agent that reported itself signed out, and only that one', async () => {
        const signIn = vi.fn((provider: string) =>
            Promise.resolve(provider === 'claude' ? ('signedOut' as const) : ('unknown' as const)),
        );
        const handler = createAgentAvailabilityHandler({
            configuration: {
                getSettings: () => ({ value: defaultAppSettings }),
            } as unknown as ConfigService,
            discover: (provider: string) =>
                Promise.resolve(provider === 'grok' ? undefined : `/fixture/bin/${provider}`),
            signIn: { read: signIn },
        });
        await expect(handler()).resolves.toEqual({
            providers: [
                { kind: 'claude', available: true, needsSignIn: true },
                { kind: 'codex', available: true },
                { kind: 'grok', available: false },
                { kind: 'antigravity', available: true },
            ],
        });
        // A missing CLI is never asked about its sign-in.
        expect(signIn.mock.calls.map(([provider]) => provider)).not.toContain('grok');
    });
});
