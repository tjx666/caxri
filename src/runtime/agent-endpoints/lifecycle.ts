import { randomUUID } from 'node:crypto';

import type { AgentLaunchSettings } from '../../shared/agents';
import { agentProviderCatalog } from '../../shared/agents';
import type {
    AgentEndpointBeginParams,
    AgentEndpointBeginResult,
    AgentEndpointRetireParams,
} from '../../shared/ipc/agent-endpoint-control';
import type { AgentPermissionClass } from '../../shared/ipc/agent-endpoint-contract';
import type { AgentProvider, TerminalRecord } from '../../shared/types';

export interface RuntimeAgentEndpointControl {
    begin(params: AgentEndpointBeginParams): Promise<AgentEndpointBeginResult>;
    retire(params: AgentEndpointRetireParams): Promise<boolean>;
}

interface ActiveEndpoint {
    launchId: string;
    ref: AgentEndpointBeginResult['ref'];
}

const ELEVATED_ARGUMENTS: Record<AgentProvider, ReadonlySet<string>> = {
    claude: new Set(['--dangerously-skip-permissions']),
    codex: new Set(['--dangerously-bypass-approvals-and-sandbox']),
};

/** Only exact built-in launch configuration is known-standard; all custom evidence fails closed. */
export function classifyAgentPermission(
    provider: AgentProvider,
    launch: AgentLaunchSettings,
): AgentPermissionClass {
    if (launch.executable !== agentProviderCatalog[provider].executableName) return 'unknown';
    if (launch.args.some((argument) => ELEVATED_ARGUMENTS[provider].has(argument)))
        return 'elevated';
    if (launch.args.length === 0) return 'standard';
    return 'unknown';
}

/** Owns the endpoint lease alongside its live direct-Agent PTY generation. */
export class RuntimeAgentEndpointLifecycle {
    private readonly active = new Map<string, ActiveEndpoint>();

    constructor(
        private readonly control: RuntimeAgentEndpointControl,
        private readonly userDataPath: string,
    ) {}

    async environment(
        terminal: TerminalRecord,
        projectId: string,
        launch: AgentLaunchSettings,
    ): Promise<NodeJS.ProcessEnv> {
        if (terminal.kind === 'shell') return {};
        await this.retire(terminal.id);
        const launchId = randomUUID();
        const endpoint = await this.control.begin({
            terminalId: terminal.id,
            sessionId: terminal.sessionId,
            projectId,
            provider: terminal.kind,
            launchId,
            name: terminal.title,
            permissionClass: classifyAgentPermission(terminal.kind, launch),
            /** Directly managed Agent Terminals consume the Host Inbox through the local CLI. */
            deliveryMode: 'pull',
        });
        this.active.set(terminal.id, { launchId, ref: endpoint.ref });
        return {
            CAXRI_AGENT_ENDPOINT_HOST_ID: endpoint.ref.hostId,
            CAXRI_AGENT_ENDPOINT_ID: endpoint.ref.endpointId,
            CAXRI_AGENT_ENDPOINT_GENERATION: String(endpoint.ref.generation),
            CAXRI_AGENT_ENDPOINT_TOKEN: endpoint.token,
            CAXRI_USER_DATA_DIR: this.userDataPath,
        };
    }

    async retire(terminalId: string): Promise<void> {
        const endpoint = this.active.get(terminalId);
        if (!endpoint) return;
        await this.control.retire({ ref: endpoint.ref, launchId: endpoint.launchId });
        if (this.active.get(terminalId) === endpoint) this.active.delete(terminalId);
    }

    async close(): Promise<void> {
        await Promise.allSettled(
            [...this.active.keys()].map((terminalId) => this.retire(terminalId)),
        );
    }
}
