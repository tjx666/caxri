import { randomUUID } from 'node:crypto';

import type {
    AgentEndpointActivateParams as AgentEndpointActivateParameters,
    AgentEndpointBeginParams as AgentEndpointBeginParameters,
    AgentEndpointBeginResult,
    AgentEndpointMessagingParams as AgentEndpointMessagingParameters,
    AgentEndpointRetireParams as AgentEndpointRetireParameters,
} from '../../../packages/protocol/src/agent/agent-endpoint-control';
import {
    agentEndpointActivateResultSchema,
    agentEndpointBeginResultSchema,
    agentEndpointMessagingResultSchema,
    agentEndpointRetireResultSchema,
    runtimeHostControlReplySchema,
} from '../../../packages/protocol/src/agent/agent-endpoint-control';
import { CaxriError, fromWireError } from '../../shared/ipc/errors';
import type { RuntimeParentPort } from '../port';

interface PendingControl {
    parse(value: unknown): unknown;
    reject(error: Error): void;
    resolve(value: unknown): void;
    timer: NodeJS.Timeout;
}

const CONTROL_TIMEOUT_MS = 5_000;

/**
Correlated private Runtime-to-Host control channel; endpoint credentials never use Runtime events.
 */
export class RuntimeAgentEndpointControlClient {
    private readonly pending = new Map<string, PendingControl>();

    constructor(private readonly port: RuntimeParentPort) {}

    private request(
        operation:
            | 'agent-endpoint.begin'
            | 'agent-endpoint.activate'
            | 'agent-endpoint.messaging'
            | 'agent-endpoint.retire',
        parameters:
            | AgentEndpointBeginParameters
            | AgentEndpointActivateParameters
            | AgentEndpointMessagingParameters
            | AgentEndpointRetireParameters,
        parse: (value: unknown) => unknown,
    ): Promise<unknown> {
        if (!this.port.connected())
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Host control is unavailable'));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CaxriError('TIMEOUT', 'Agent Endpoint control timed out'));
            }, CONTROL_TIMEOUT_MS);
            this.pending.set(id, { parse, reject, resolve, timer });
            try {
                this.port.send({ type: 'host-control.request', id, operation, params: parameters });
            } catch {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new CaxriError('UNAVAILABLE', 'Host control is unavailable'));
            }
        });
    }

    begin(parameters: AgentEndpointBeginParameters): Promise<AgentEndpointBeginResult> {
        return this.request('agent-endpoint.begin', parameters, (value) =>
            agentEndpointBeginResultSchema.parse(value),
        ) as Promise<AgentEndpointBeginResult>;
    }

    async activate(parameters: AgentEndpointActivateParameters): Promise<boolean> {
        const result = await this.request('agent-endpoint.activate', parameters, (value) =>
            agentEndpointActivateResultSchema.parse(value),
        );
        return (result as { activated: boolean }).activated;
    }

    async messaging(parameters: AgentEndpointMessagingParameters): Promise<boolean> {
        const result = await this.request('agent-endpoint.messaging', parameters, (value) =>
            agentEndpointMessagingResultSchema.parse(value),
        );
        return (result as { updated: boolean }).updated;
    }

    async retire(parameters: AgentEndpointRetireParameters): Promise<boolean> {
        const result = await this.request('agent-endpoint.retire', parameters, (value) =>
            agentEndpointRetireResultSchema.parse(value),
        );
        return (result as { retired: boolean }).retired;
    }

    handleMessage(raw: unknown): boolean {
        const parsed = runtimeHostControlReplySchema.safeParse(raw);
        if (!parsed.success) return false;
        const pending = this.pending.get(parsed.data.id);
        if (!pending) return true;
        clearTimeout(pending.timer);
        this.pending.delete(parsed.data.id);
        if (!parsed.data.ok) {
            pending.reject(fromWireError(parsed.data.error));
            return true;
        }
        try {
            pending.resolve(pending.parse(parsed.data.result));
        } catch {
            pending.reject(
                new CaxriError('INTERNAL', 'Host returned invalid endpoint control data'),
            );
        }
        return true;
    }

    close(): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new CaxriError('UNAVAILABLE', 'Agent Endpoint control is closing'));
        }
        this.pending.clear();
    }
}
