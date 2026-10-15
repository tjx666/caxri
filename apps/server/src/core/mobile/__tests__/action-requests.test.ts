// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type { AgentAction, Principal } from '@caxri/protocol';
import { MOBILE_AGENT_ACTIONS_MAX } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import { listMobileAgentActions } from '../action-requests';

const principal: Extract<Principal, { kind: 'paired-device' }> = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'view',
    projectIds: ['project-1'],
};

const skill = (name: string, description?: string): AgentAction => ({
    invocation: `$${name}`,
    kind: 'skill',
    ...(description && { description }),
    requiresArguments: false,
    source: 'project',
});

/**
 * More skills than one reply carries, with the one the user wants listed last.
 */
const actions = [
    ...Array.from({ length: MOBILE_AGENT_ACTIONS_MAX + 5 }, (_, index) => skill(`filler-${index}`)),
    skill('todo-sweep', 'Find stale TODO comments'),
];

const domainFixture = () => {
    const request = vi.fn(async (method: string) => {
        if (method === 'terminal.queryForPrincipal')
            return { terminals: [{ id: 'terminal-1', sessionId: 'session-1' }] };
        if (method === 'agentActions.list') return { actions, discovery: 'complete' };
        throw new Error(`Unexpected ${method}`);
    });
    return { request } as unknown as ServerDomainService;
};

const list = (query?: string) =>
    listMobileAgentActions(
        {
            method: 'mobile.agent.actions',
            params: {
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                ...(query !== undefined && { query }),
            },
        },
        principal,
        domainFixture(),
        () => {},
    );

describe('mobile.agent.actions', () => {
    it('keeps the first actions in discovery order without a query', async () => {
        const result = await list();
        expect(result.actions).toHaveLength(MOBILE_AGENT_ACTIONS_MAX);
        expect(result.actions[0]?.invocation).toBe('$filler-0');
        expect(result.truncated).toBe(true);
    });

    it('ranks the whole list before keeping the top slice, so a skill past the cut is found', async () => {
        const result = await list('to');
        expect(result.actions[0]?.invocation).toBe('$todo-sweep');
        expect(result.truncated).toBe(false);
        expect((await list('$todo')).actions.map((action) => action.invocation)).toEqual([
            '$todo-sweep',
        ]);
    });
});
