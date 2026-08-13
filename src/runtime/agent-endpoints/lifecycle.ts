import { randomUUID } from 'node:crypto';

import type { AgentLaunchSettings, AgentProviderSettings } from '../../shared/agents';
import { agentProviderCatalog } from '../../shared/agents';
import type {
    AgentEndpointBeginParams,
    AgentEndpointBeginResult,
    AgentEndpointMessagingParams,
    AgentEndpointRetireParams,
} from '../../shared/ipc/agent-endpoint-control';
import type { AgentPermissionClass } from '../../shared/ipc/agent-endpoint-contract';
import type { AgentEndpointRef } from '../../shared/ipc/agent-endpoint-contract';
import { CaxriError } from '../../shared/ipc/errors';
import type { AgentProvider, TerminalRecord } from '../../shared/types';
import { AgentMessagingCapabilityProbe, type AgentMessagingProbeInput } from '../agent-messaging';

export interface RuntimeAgentEndpointControl {
    begin(params: AgentEndpointBeginParams): Promise<AgentEndpointBeginResult>;
    messaging(params: AgentEndpointMessagingParams): Promise<boolean>;
    retire(params: AgentEndpointRetireParams): Promise<boolean>;
}

interface ActiveEndpoint {
    launch: AgentLaunchSettings;
    launchId: string;
    provider: AgentProvider;
    ref: AgentEndpointBeginResult['ref'];
    terminalId: string;
}

export interface RuntimeAgentControlTarget {
    launchId: string;
    ref: AgentEndpointRef;
    terminalId: string;
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
        private readonly messagingProbe = new AgentMessagingCapabilityProbe({
            cliPath: process.env.CAXRI_CLI_PATH,
        }),
    ) {}

    async environment(
        terminal: TerminalRecord,
        projectId: string,
        settings: AgentProviderSettings,
    ): Promise<NodeJS.ProcessEnv> {
        if (terminal.kind === 'shell') return {};
        await this.retire(terminal.id);
        const launchId = randomUUID();
        const messaging = await this.messagingProbe.check({
            enabled: settings.messaging.enabled,
            launch: settings.launch,
            provider: terminal.kind,
        });
        const endpoint = await this.control.begin({
            terminalId: terminal.id,
            sessionId: terminal.sessionId,
            projectId,
            provider: terminal.kind,
            launchId,
            name: terminal.title,
            permissionClass: classifyAgentPermission(terminal.kind, settings.launch),
            messaging,
        });
        this.active.set(terminal.id, {
            launch: settings.launch,
            launchId,
            provider: terminal.kind,
            ref: endpoint.ref,
            terminalId: terminal.id,
        });
        return {
            CAXRI_AGENT_ENDPOINT_HOST_ID: endpoint.ref.hostId,
            CAXRI_AGENT_ENDPOINT_ID: endpoint.ref.endpointId,
            CAXRI_AGENT_ENDPOINT_GENERATION: String(endpoint.ref.generation),
            CAXRI_AGENT_ENDPOINT_TOKEN: endpoint.token,
            ...(process.env.CAXRI_CLI_PATH ? { CAXRI_CLI_PATH: process.env.CAXRI_CLI_PATH } : {}),
            CAXRI_USER_DATA_DIR: this.userDataPath,
        };
    }

    async reconcile(settings: Record<AgentProvider, AgentProviderSettings>): Promise<void> {
        this.messagingProbe.invalidate();
        await Promise.all(
            [...this.active.values()].map(async (endpoint) => {
                const providerSettings = settings[endpoint.provider];
                const input = {
                    enabled: providerSettings.messaging.enabled,
                    launch: endpoint.launch,
                    provider: endpoint.provider,
                } satisfies AgentMessagingProbeInput;
                const messaging = await this.messagingProbe.check(input);
                await this.control.messaging({
                    ref: endpoint.ref,
                    launchId: endpoint.launchId,
                    messaging,
                });
            }),
        );
    }

    async retire(terminalId: string): Promise<void> {
        const endpoint = this.active.get(terminalId);
        if (!endpoint) return;
        await this.control.retire({ ref: endpoint.ref, launchId: endpoint.launchId });
        if (this.active.get(terminalId) === endpoint) this.active.delete(terminalId);
    }

    endpointForTerminal(terminalId: string): RuntimeAgentControlTarget | undefined {
        const endpoint = this.active.get(terminalId);
        return endpoint
            ? { launchId: endpoint.launchId, ref: endpoint.ref, terminalId: endpoint.terminalId }
            : undefined;
    }

    /** Resolves an exact live Endpoint generation before a Runtime-owned PTY side effect. */
    controlTarget(ref: AgentEndpointRef): RuntimeAgentControlTarget {
        const endpoint = [...this.active.values()].find(
            (candidate) =>
                candidate.ref.hostId === ref.hostId &&
                candidate.ref.endpointId === ref.endpointId &&
                candidate.ref.generation === ref.generation,
        );
        if (!endpoint) throw new CaxriError('UNAVAILABLE', 'Agent Endpoint is unavailable');
        return { launchId: endpoint.launchId, ref: endpoint.ref, terminalId: endpoint.terminalId };
    }

    isCurrent(target: RuntimeAgentControlTarget): boolean {
        const current = this.active.get(target.terminalId);
        return Boolean(
            current &&
            current.launchId === target.launchId &&
            current.ref.endpointId === target.ref.endpointId &&
            current.ref.generation === target.ref.generation,
        );
    }

    async close(): Promise<void> {
        await Promise.allSettled(
            [...this.active.keys()].map((terminalId) => this.retire(terminalId)),
        );
    }
}
