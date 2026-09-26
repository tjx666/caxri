import { defaultAppSettings } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ConfigService } from '../../config';
import type { CaxriDatabase } from '../../db';
import { createMobileAgentAvailabilityHandler } from '../agent-availability';

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
            { kind: 'shell', available: true },
        ]);
        expect(JSON.stringify(result)).not.toContain('/fixture/bin');
    });
});
