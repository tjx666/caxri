import { describe, expect, it, vi } from 'vitest';

import { createMemoryMobileDeviceStore } from '../../__tests__/credential-stores.fixture';
import { createAllProjectsGrantFollower } from '../all-projects-grant';
import { MobileDeviceRegistry } from '../device-registry';

const project = (id: string, ownerProjectId?: string) => ({
    id,
    title: id,
    ...(ownerProjectId && { ownerProjectId }),
});

function fixture() {
    let byte = 1;
    const registry = MobileDeviceRegistry.open({
        store: createMemoryMobileDeviceStore(),
        now: () => 1_788_106_000_000,
        random: (bytes: number) => new Uint8Array(bytes).fill(byte++),
    });
    let projects = [project('project-1')];
    const request = vi.fn(() => Promise.resolve({ view: 'desktop' as const, projects }));
    const logger = { write: vi.fn() };
    const follower = createAllProjectsGrantFollower(registry, { request } as never, logger);
    return {
        follower,
        logger,
        registry,
        request,
        setProjects: (next: Array<ReturnType<typeof project>>) => (projects = next),
    };
}

describe('createAllProjectsGrantFollower', () => {
    it('grants a Project added after pairing, skipping worktree Projects', async () => {
        const { follower, logger, registry, setProjects } = fixture();
        const { device } = await registry.pair({
            allProjects: true,
            displayName: 'Phone',
            platform: 'android',
            projectIds: ['project-1'],
        });

        setProjects([project('project-1'), project('play'), project('worktree-1', 'project-1')]);
        follower.follow();
        await follower.settled();

        expect(registry.currentPrincipal(device.deviceId, device.generation)).toMatchObject({
            projectIds: ['project-1', 'play'],
        });
        expect(logger.write).toHaveBeenCalledWith('info', 'mobile_gateway.all_projects_grant', {
            fields: { capped: 0, granted: 1, outcome: 'granted' },
        });
    });

    it('coalesces triggers that arrive during a run into one more read', async () => {
        const { follower, request } = fixture();
        follower.follow();
        follower.follow();
        follower.follow();
        await follower.settled();
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('logs a failed Project read instead of throwing', async () => {
        const { follower, logger, request } = fixture();
        request.mockRejectedValueOnce(new Error('closed'));
        follower.follow();
        await follower.settled();
        expect(logger.write).toHaveBeenCalledWith('warn', 'mobile_gateway.all_projects_grant', {
            fields: { capped: 0, granted: 0, outcome: 'failed' },
        });
    });
});
