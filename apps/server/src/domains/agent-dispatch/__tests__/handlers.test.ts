import type { AgentEndpointRef } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEndpointLifecycle } from '../../agent-endpoints';
import type { AgentCoordinator } from '../../agents';
import type { CaxriDatabase } from '../../db';
import type { TerminalManager } from '../../terminal';
import { createAgentCommandHandlers } from '../handlers';
import type { AgentDispatchService } from '../service';

const ENDPOINT: AgentEndpointRef = {
    endpointId: 'endpoint-1',
    generation: 1,
    hostId: 'host-1',
};

describe('Agent command handlers', () => {
    it('signals the exact managed Agent launch instead of the outer Shell process', () => {
        const signalAgentExact = vi.fn(() => true);
        const signalExact = vi.fn(() => true);
        const target = {
            launchId: 'launch-1',
            ref: ENDPOINT,
            terminalId: 'terminal-1',
        };
        const handlers = createAgentCommandHandlers({
            coordinator: {} as AgentCoordinator,
            database: {} as CaxriDatabase,
            dispatch: {} as AgentDispatchService,
            emit: vi.fn(),
            endpoints: {
                controlTarget: vi.fn(() => target),
                isCurrent: vi.fn(() => true),
            } as unknown as AgentEndpointLifecycle,
            mainOwned: () => {
                throw new Error('Unexpected public handler call');
            },
            terminals: {
                processId: vi.fn(() => 4_242),
                signalAgentExact,
                signalExact,
            } as unknown as TerminalManager,
        });

        expect(handlers['agent.control.interruptInternal']({ endpoint: ENDPOINT })).toEqual({
            endpoint: ENDPOINT,
            outcome: 'signaled',
            terminalId: 'terminal-1',
        });
        expect(signalAgentExact).toHaveBeenCalledWith('terminal-1', 'launch-1', 'SIGINT');
        expect(signalExact).not.toHaveBeenCalled();
    });
});
