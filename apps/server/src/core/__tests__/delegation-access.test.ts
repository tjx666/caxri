import type { CommandExecutionContext } from '@caxri/protocol';
import { expect, it, vi } from 'vitest';

import { invokeDelegationAccess } from '../delegation-access';
import { DelegationAccessRegistry } from '../delegation-access-registry';
import { createMemoryDelegationClientStore } from './credential-stores.fixture';

it('requires the owner CLI and validates the authoritative directory binding before issuing credentials', async () => {
    const registry = DelegationAccessRegistry.open(createMemoryDelegationClientStore());
    const forward = vi.fn(() =>
        Promise.resolve({ projectId: 'project', sessionId: 'session', callerProvider: 'codex' }),
    );
    const request = {
        method: 'agent.delegation.access.create',
        params: {
            rootPath: '/explicit/root',
            callerProvider: 'codex',
            registerProject: true,
            ttlMs: 60_000,
        },
    } as const;
    const desktop: CommandExecutionContext = {
        capabilities: ['desktop'],
        principal: { kind: 'desktop', id: 'desktop', generation: 1 },
    };
    await expect(invokeDelegationAccess(request, desktop, registry, forward)).rejects.toMatchObject(
        { code: 'FORBIDDEN' },
    );
    expect(forward).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
    const owner: CommandExecutionContext = {
        capabilities: ['agents.delegation.access'],
        principal: { kind: 'human-cli', id: 'owner' },
    };
    const issued = await invokeDelegationAccess(request, owner, registry, forward);
    expect(forward).toHaveBeenCalledWith({
        method: 'agent.delegation.access.bootstrap',
        params: request.params,
    });
    expect(issued).toMatchObject({
        projectId: 'project',
        sessionId: 'session',
        callerProvider: 'codex',
    });
    await expect(
        invokeDelegationAccess(request, owner, registry, () =>
            Promise.resolve({ projectId: 'project' }),
        ),
    ).rejects.toThrow();
    expect(registry.list()).toHaveLength(1);
});
