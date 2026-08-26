import type { AgentEndpointSummary, AgentProviderSettings, TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { RuntimeAgentEndpointLifecycle } from './agent-endpoints';
import type { AgentCoordinator, AgentLifecycleSignal } from './agents';
import type { WorkbenchRootService } from './workbench-roots';

interface BoundedSerialBatcherOptions<Key> {
    capacity: number;
    delayMs: number;
    onCapacity(): void;
    run(keys: readonly Key[]): Promise<void>;
}

/**
 * Coalesces a high-frequency lifecycle boundary into one active batch plus one bounded pending set. New keys received
 * while Git work is in flight cannot append promise-chain nodes; they become one later batch instead.
 */
export class BoundedSerialBatcher<Key> {
    private readonly pending = new Set<Key>();
    private active = false;
    private closed = false;
    private timer?: NodeJS.Timeout;

    constructor(private readonly options: BoundedSerialBatcherOptions<Key>) {}

    private arm(): void {
        if (this.active || this.closed || this.timer || this.pending.size === 0) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, this.options.delayMs);
        this.timer.unref();
    }

    private flush(): void {
        if (this.active || this.closed) return;
        const keys = [...this.pending];
        this.pending.clear();
        this.active = true;
        // The lifecycle callback is synchronous; the batch owns and contains its asynchronous failure.
        // eslint-disable-next-line no-void -- the finally block exclusively schedules the next bounded batch
        void this.options
            .run(keys)
            .catch(() => {})
            .finally(() => {
                this.active = false;
                this.arm();
            });
    }

    schedule(key: Key): boolean {
        if (this.closed) return false;
        if (!this.pending.has(key) && this.pending.size >= this.options.capacity) {
            this.options.onCapacity();
            return false;
        }
        this.pending.add(key);
        this.arm();
        return true;
    }

    close(): void {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.pending.clear();
    }
}

export function didHandleAgentLifecycleSignal(
    coordinator: AgentCoordinator,
    workbenchRoots: WorkbenchRootService,
    signal: AgentLifecycleSignal,
): boolean {
    return signal.phase === 'shellToolFinished'
        ? workbenchRoots.observeShellToolFinished(signal)
        : coordinator.observeLifecycleSignal(signal);
}

export function isCurrentAgentWorkbenchEndpoint(
    endpoints: RuntimeAgentEndpointLifecycle | undefined,
    endpoint: AgentEndpointSummary,
): boolean {
    try {
        return endpoints?.controlTarget(endpoint.ref).terminalId === endpoint.terminalId;
    } catch {
        return false;
    }
}

export async function retireAgentWorkbenchProvenance(options: {
    endpoints: RuntimeAgentEndpointLifecycle | undefined;
    logger: StructuredLogger;
    terminalId: string;
    workbenchRoots: WorkbenchRootService;
}): Promise<void> {
    options.workbenchRoots.retireTerminal(options.terminalId);
    try {
        await options.endpoints?.retire(options.terminalId);
    } catch (error: unknown) {
        options.logger.write('warn', logEventCatalog.agentEndpoint.retireFailed, {
            fields: {
                terminalId: options.terminalId,
                error: error instanceof Error ? error.message : String(error),
            },
        });
    }
}

/**
 * Prepares a generation-scoped Endpoint and records its owning Git topology before the Agent process can spawn.
 */
export async function prepareAgentWorkbenchProvenance(options: {
    endpoints: RuntimeAgentEndpointLifecycle;
    projectId: string;
    settings: AgentProviderSettings;
    terminal: TerminalRecord;
    workbenchRoots: WorkbenchRootService;
}): Promise<NodeJS.ProcessEnv> {
    const { endpoints, projectId, settings, terminal, workbenchRoots } = options;
    if (terminal.kind === 'shell')
        throw new CaxriError('CONFLICT', 'Shell Terminals cannot establish Agent provenance');
    const environment = await endpoints.environment(terminal, projectId, settings);
    const endpoint = endpoints.preparedEndpointForTerminal(terminal.id);
    if (!endpoint)
        throw new CaxriError(
            'UNAVAILABLE',
            'Agent Endpoint generation was not prepared before launch',
        );
    await workbenchRoots.primeAgentEndpoint({
        projectId,
        provider: terminal.kind,
        ref: endpoint.ref,
        sessionId: terminal.sessionId,
        terminalId: terminal.id,
    });
    return environment;
}
