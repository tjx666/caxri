import { randomUUID } from 'node:crypto';

import type { AgentLaunchSettings, AgentProviderSettings } from '../../shared/agents';
import { agentProviderCatalog } from '../../shared/agents';
import type {
    AgentEndpointActivateParams,
    AgentEndpointBeginParams,
    AgentEndpointBeginResult,
    AgentEndpointMessagingParams,
    AgentEndpointRetireParams,
} from '../../../packages/protocol/src/agent/agent-endpoint-control';
import type { AgentPermissionClass } from '../../shared/ipc/agent-endpoint-contract';
import type { AgentEndpointRef } from '../../shared/ipc/agent-endpoint-contract';
import { CaxriError } from '../../shared/ipc/errors';
import type { AgentProvider, TerminalRecord } from '../../shared/types';
import {
    AgentMessagingCapabilityProbe,
    pendingMessagingCapability,
    type AgentMessagingProbeInput,
} from '../agent-messaging';

export interface RuntimeAgentEndpointControl {
    activate(params: AgentEndpointActivateParams): Promise<boolean>;
    begin(params: AgentEndpointBeginParams): Promise<AgentEndpointBeginResult>;
    messaging(params: AgentEndpointMessagingParams): Promise<boolean>;
    retire(params: AgentEndpointRetireParams): Promise<boolean>;
}

interface ActiveEndpoint {
    activated: boolean;
    launch: AgentLaunchSettings;
    launchId: string;
    messagingEnabled: boolean;
    messagingRevision: number;
    provider: AgentProvider;
    ref: AgentEndpointBeginResult['ref'];
    retiring: boolean;
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
        const endpoint = await this.control.begin({
            terminalId: terminal.id,
            sessionId: terminal.sessionId,
            projectId,
            provider: terminal.kind,
            launchId,
            name: terminal.title,
            permissionClass: classifyAgentPermission(terminal.kind, settings.launch),
            /** A credential exists for the child env before spawn, but the Host keeps it inert. */
            messaging: pendingMessagingCapability(),
        });
        this.active.set(terminal.id, {
            activated: false,
            launch: settings.launch,
            launchId,
            messagingEnabled: settings.messaging.enabled,
            messagingRevision: 0,
            provider: terminal.kind,
            ref: endpoint.ref,
            retiring: false,
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

    /** Activates the exact prepared credential after TerminalManager has registered the live PTY. */
    async activate(terminalId: string): Promise<void> {
        const endpoint = this.active.get(terminalId);
        if (!endpoint || endpoint.retiring)
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint is unavailable after PTY launch');
        const activated = await this.control.activate({
            ref: endpoint.ref,
            launchId: endpoint.launchId,
        });
        if (!activated || endpoint.retiring || this.active.get(terminalId) !== endpoint)
            throw new CaxriError(
                'UNAVAILABLE',
                'Agent Endpoint generation changed before activation',
            );
        endpoint.activated = true;
        this.scheduleMessagingRefresh(endpoint);
    }

    async reconcile(settings: Record<AgentProvider, AgentProviderSettings>): Promise<void> {
        this.messagingProbe.invalidate();
        const groups = new Map<
            string,
            { endpoints: ActiveEndpoint[]; input: AgentMessagingProbeInput }
        >();
        for (const endpoint of this.active.values()) {
            const providerSettings = settings[endpoint.provider];
            endpoint.messagingEnabled = providerSettings.messaging.enabled;
            endpoint.messagingRevision += 1;
            if (!endpoint.activated || endpoint.retiring) continue;
            const input = {
                enabled: endpoint.messagingEnabled,
                launch: endpoint.launch,
                provider: endpoint.provider,
            } satisfies AgentMessagingProbeInput;
            const key = JSON.stringify([
                input.provider,
                input.launch.executable,
                ...input.launch.args,
            ]);
            const group = groups.get(key) ?? { endpoints: [], input };
            group.endpoints.push(endpoint);
            groups.set(key, group);
        }
        await Promise.all(
            [...groups.values()].map(async ({ endpoints, input }) => {
                const messaging = await this.messagingProbe.check(input);
                await Promise.all(
                    endpoints.map((endpoint) =>
                        this.updateMessaging(endpoint, endpoint.messagingRevision, messaging),
                    ),
                );
            }),
        );
    }

    async retire(terminalId: string): Promise<void> {
        const endpoint = this.active.get(terminalId);
        if (!endpoint) return;
        endpoint.retiring = true;
        /** Keep the local generation fenced if Host retirement fails, so a later caller may retry safely. */
        await this.control.retire({ ref: endpoint.ref, launchId: endpoint.launchId });
        if (this.active.get(terminalId) === endpoint) this.active.delete(terminalId);
    }

    endpointForTerminal(terminalId: string): RuntimeAgentControlTarget | undefined {
        const endpoint = this.active.get(terminalId);
        return endpoint?.activated && !endpoint.retiring
            ? { launchId: endpoint.launchId, ref: endpoint.ref, terminalId: endpoint.terminalId }
            : undefined;
    }

    /** Resolves an exact live Endpoint generation before a Runtime-owned PTY side effect. */
    controlTarget(ref: AgentEndpointRef): RuntimeAgentControlTarget {
        const endpoint = [...this.active.values()].find(
            (candidate) =>
                candidate.activated &&
                !candidate.retiring &&
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
            current.activated &&
            !current.retiring &&
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

    private scheduleMessagingRefresh(endpoint: ActiveEndpoint): void {
        const input = {
            enabled: endpoint.messagingEnabled,
            launch: endpoint.launch,
            provider: endpoint.provider,
        } satisfies AgentMessagingProbeInput;
        const revision = endpoint.messagingRevision;
        void this.messagingProbe
            .check(input)
            .then((messaging) => this.updateMessaging(endpoint, revision, messaging))
            .catch(() => undefined);
    }

    /** A delayed capability result must never update a replacement Endpoint or newer settings revision. */
    private async updateMessaging(
        endpoint: ActiveEndpoint,
        revision: number,
        messaging: Parameters<RuntimeAgentEndpointControl['messaging']>[0]['messaging'],
    ): Promise<void> {
        if (
            this.active.get(endpoint.terminalId) !== endpoint ||
            !endpoint.activated ||
            endpoint.retiring ||
            endpoint.messagingRevision !== revision
        )
            return;
        await this.control.messaging({
            ref: endpoint.ref,
            launchId: endpoint.launchId,
            messaging,
        });
    }
}
