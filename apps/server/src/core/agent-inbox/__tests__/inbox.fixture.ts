import type {
    AgentEndpointBeginParams as AgentEndpointBeginParameters,
    AgentMessageReceipt,
} from '@caxri/protocol';

import { AgentEndpointRegistry } from '../../agent-endpoints';
import { AgentInboxRegistry } from '..';
import type { AgentInboxRegistryOptions } from '../types';

function token(index: number): string {
    return index.toString(16).padStart(64, '0');
}

/**
 * A Peer Inbox over a real endpoint registry with a controllable clock and deterministic tokens and message IDs.
 */
export function setup(options: Pick<AgentInboxRegistryOptions, 'logger'> = {}) {
    let now = 10_000;
    let nextToken = 1;
    let nextId = 1;
    const issuedTokens: string[] = [];
    const endpoints = new AgentEndpointRegistry('host-1', {
        now: () => now,
        token: () => {
            const value = token(nextToken++);
            issuedTokens.push(value);
            return value;
        },
    });
    const receiptEvents: AgentMessageReceipt[] = [];
    const inbox = new AgentInboxRegistry(endpoints, {
        emitReceipt: (_endpoint, receipt) => {
            receiptEvents.push(receipt);
        },
        id: () => `message-${nextId++}`,
        now: () => now,
        ...options,
    });

    function begin(overrides: Partial<AgentEndpointBeginParameters> = {}) {
        const index = issuedTokens.length;
        const result = endpoints.begin({
            terminalId: `terminal-${index + 1}`,
            sessionId: 'session-1',
            projectId: 'project-1',
            provider: 'codex',
            launchId: `launch-${index + 1}`,
            name: `Agent ${index + 1}`,
            permissionClass: 'standard',
            messaging: {
                deliveryMode: 'pull',
                health: 'ready',
                reason: 'pull_ready',
                checkedAt: 1,
                nextAction: 'use_pull',
            },
            ...overrides,
        });
        const launchId = `launch-${index + 1}`;
        if (!endpoints.activate({ ref: result.ref, launchId }))
            throw new Error('Agent Endpoint activation failed in test setup');
        const context = endpoints.authenticate({
            ...result.ref,
            token: issuedTokens[index],
        });
        return { context, result };
    }

    return {
        advance: (milliseconds: number) => {
            now += milliseconds;
        },
        begin,
        endpoints,
        inbox,
        receiptEvents,
    };
}

export function sendInput(
    to: { hostId: string; endpointId: string; generation: number },
    body: string,
) {
    return { to, body, ttlMs: 300_000 };
}
