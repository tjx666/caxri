import { randomUUID } from 'node:crypto';

import {
    agentEndpointActivateResultSchema,
    agentEndpointBeginResultSchema,
    agentEndpointMessagingResultSchema,
    agentEndpointRetireResultSchema,
    runtimeHostControlReplySchema,
    type AgentEndpointActivateParams,
    type AgentEndpointBeginParams,
    type AgentEndpointBeginResult,
    type AgentEndpointMessagingParams,
    type AgentEndpointRetireParams,
} from '../../shared/ipc/agent-endpoint-control';
import { CaxriError, fromWireError } from '../../shared/ipc/errors';
import type { RuntimeParentPort } from '../port';

interface PendingControl {
    parse(value: unknown): unknown;
    reject(error: Error): void;
    resolve(value: unknown): void;
    timer: NodeJS.Timeout;
}

const CONTROL_TIMEOUT_MS = 5_000;

/** Correlated private Runtime-to-Host control channel; endpoint credentials never use Runtime events. */
export class RuntimeAgentEndpointControlClient {
    private readonly pending = new Map<string, PendingControl>();

    constructor(private readonly port: RuntimeParentPort) {}

    begin(params: AgentEndpointBeginParams): Promise<AgentEndpointBeginResult> {
        return this.request('agent-endpoint.begin', params, (value) =>
            agentEndpointBeginResultSchema.parse(value),
        ) as Promise<AgentEndpointBeginResult>;
    }

    activate(params: AgentEndpointActivateParams): Promise<boolean> {
        return this.request('agent-endpoint.activate', params, (value) =>
            agentEndpointActivateResultSchema.parse(value),
        ).then((result) => (result as { activated: boolean }).activated);
    }

    messaging(params: AgentEndpointMessagingParams): Promise<boolean> {
        return this.request('agent-endpoint.messaging', params, (value) =>
            agentEndpointMessagingResultSchema.parse(value),
        ).then((result) => (result as { updated: boolean }).updated);
    }

    retire(params: AgentEndpointRetireParams): Promise<boolean> {
        return this.request('agent-endpoint.retire', params, (value) =>
            agentEndpointRetireResultSchema.parse(value),
        ).then((result) => (result as { retired: boolean }).retired);
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

    private request(
        operation:
            | 'agent-endpoint.begin'
            | 'agent-endpoint.activate'
            | 'agent-endpoint.messaging'
            | 'agent-endpoint.retire',
        params:
            | AgentEndpointBeginParams
            | AgentEndpointActivateParams
            | AgentEndpointMessagingParams
            | AgentEndpointRetireParams,
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
                this.port.send({ type: 'host-control.request', id, operation, params });
            } catch {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new CaxriError('UNAVAILABLE', 'Host control is unavailable'));
            }
        });
    }
}
