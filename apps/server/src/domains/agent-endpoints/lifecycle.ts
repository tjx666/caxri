import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type {
    AgentEndpointActivateParams as AgentEndpointActivateParameters,
    AgentEndpointBeginParams as AgentEndpointBeginParameters,
    AgentEndpointBeginResult,
    AgentEndpointMessagingParams as AgentEndpointMessagingParameters,
    AgentEndpointRef as AgentEndpointReference,
    AgentEndpointRetireParams as AgentEndpointRetireParameters,
    AgentLaunchSettings,
    AgentPermissionClass,
    AgentProvider,
    AgentProviderSettings,
    TerminalRecord,
} from '@caxri/protocol';
import { agentProviderCatalog, CaxriError } from '@caxri/protocol';
import { expandLaunchArguments } from '@caxri/utils';

import type { AgentMessagingProbeInput } from '../agent-messaging';
import { AgentMessagingCapabilityProbe, pendingMessagingCapability } from '../agent-messaging';

export interface AgentEndpointControl {
    activate(parameters: AgentEndpointActivateParameters): Promise<boolean>;
    begin(parameters: AgentEndpointBeginParameters): Promise<AgentEndpointBeginResult>;
    messaging(parameters: AgentEndpointMessagingParameters): Promise<boolean>;
    retire(parameters: AgentEndpointRetireParameters): Promise<boolean>;
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

export interface AgentControlTarget {
    launchId: string;
    ref: AgentEndpointReference;
    terminalId: string;
}

const ELEVATED_ARGUMENTS: Record<AgentProvider, ReadonlySet<string>> = {
    grok: new Set(['--always-approve', '--yolo', '--dangerously-skip-permissions']),
    claude: new Set(['--dangerously-skip-permissions']),
    codex: new Set(['--dangerously-bypass-approvals-and-sandbox']),
};

/**
 * Endpoint names follow the durable conversation title only after provider metadata has established that conversation.
 * Before then, the catalog title avoids replaying a stale semantic title into a fresh Agent generation. Endpoint names
 * are creation-time metadata; Caxri deliberately has no dynamic rename protocol.
 */
function agentEndpointName(
    terminal: Pick<TerminalRecord, 'agentSessionId' | 'title'>,
    provider: AgentProvider,
): string {
    return terminal.agentSessionId ? terminal.title : agentProviderCatalog[provider].displayName;
}

/**
 * Only exact built-in launch configuration is known-standard; all custom evidence fails closed.
 */
export function classifyAgentPermission(
    provider: AgentProvider,
    launch: AgentLaunchSettings,
): AgentPermissionClass {
    if (launch.executable !== agentProviderCatalog[provider].executableName) return 'unknown';
    const arguments_ = expandLaunchArguments(launch.args);
    if (arguments_.some((argument) => ELEVATED_ARGUMENTS[provider].has(argument)))
        return 'elevated';
    if (arguments_.length === 0) return 'standard';
    return 'unknown';
}

/**
 * Owns the endpoint lease alongside its live direct-Agent PTY generation.
 */
export class AgentEndpointLifecycle {
    private readonly active = new Map<string, ActiveEndpoint>();

    constructor(
        private readonly control: AgentEndpointControl,
        private readonly userDataPath: string,
        private readonly messagingProbe = new AgentMessagingCapabilityProbe({
            cliPath: process.env.CAXRI_CLI_PATH,
        }),
    ) {}

    /**
     * Fires without blocking `activate()`; failures are swallowed since this is a best-effort refresh.
     */
    private scheduleMessagingRefresh(endpoint: ActiveEndpoint): void {
        const input = {
            enabled: endpoint.messagingEnabled,
            launch: endpoint.launch,
            provider: endpoint.provider,
        } satisfies AgentMessagingProbeInput;
        // eslint-disable-next-line unicorn/prefer-await -- must stay synchronous so activate() is not blocked on this best-effort background refresh
        this.refreshMessaging(endpoint, endpoint.messagingRevision, input).catch(() => {});
    }

    private async refreshMessaging(
        endpoint: ActiveEndpoint,
        revision: number,
        input: AgentMessagingProbeInput,
    ): Promise<void> {
        const messaging = await this.messagingProbe.check(input);
        await this.updateMessaging(endpoint, revision, messaging);
    }

    /**
     * A delayed capability result must never update a replacement Endpoint or newer settings revision.
     */
    private async updateMessaging(
        endpoint: ActiveEndpoint,
        revision: number,
        messaging: Parameters<AgentEndpointControl['messaging']>[0]['messaging'],
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

    async environment(
        terminal: TerminalRecord,
        projectId: string,
        settings: AgentProviderSettings,
        launchId: string = randomUUID(),
        role?: AgentEndpointBeginParameters['role'],
    ): Promise<NodeJS.ProcessEnv> {
        if (terminal.kind === 'shell') return {};
        await this.retire(terminal.id);
        const endpoint = await this.control.begin({
            terminalId: terminal.id,
            sessionId: terminal.sessionId,
            projectId,
            provider: terminal.kind,
            launchId,
            name: agentEndpointName(terminal, terminal.kind),
            permissionClass: classifyAgentPermission(terminal.kind, settings.launch),
            /**
             * A credential exists for the child env before spawn, but the Server keeps it inert.
             */
            messaging: pendingMessagingCapability(),
            role,
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
            /**
             * Public, non-authorizing marker inherited by provider hooks. Personal notification hooks use it to avoid
             * duplicating Caxri-owned notifications without depending on Endpoint credentials or internal identities.
             */
            CAXRI_MANAGED_AGENT: '1',
            CAXRI_AGENT_ENDPOINT_HOST_ID: endpoint.ref.hostId,
            CAXRI_AGENT_ENDPOINT_ID: endpoint.ref.endpointId,
            CAXRI_AGENT_ENDPOINT_GENERATION: String(endpoint.ref.generation),
            CAXRI_AGENT_ENDPOINT_TOKEN: endpoint.token,
            ...(process.env.CAXRI_CLI_PATH && { CAXRI_CLI_PATH: process.env.CAXRI_CLI_PATH }),
            CAXRI_USER_DATA_DIR: this.userDataPath,
        };
    }

    /**
     * Activates the exact prepared credential after TerminalManager has registered the live PTY.
     */
    async activate(terminalId: string): Promise<void> {
        const endpoint = this.active.get(terminalId);
        if (!endpoint || endpoint.retiring)
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint is unavailable after PTY launch');
        const isActivated = await this.control.activate({
            ref: endpoint.ref,
            launchId: endpoint.launchId,
        });
        // `endpoint.retiring` can flip to true while `this.control.activate` above is awaited (a
        // concurrent retire); the checker narrows it from the guard at entry and does not account
        // for that async mutation.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- retiring can change during the preceding await
        if (!isActivated || endpoint.retiring || this.active.get(terminalId) !== endpoint)
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
            groups.values().map(async ({ endpoints, input }) => {
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
        /**
         * Keep the local generation fenced if Server retirement fails, so a later caller may retry safely.
         */
        await this.control.retire({ ref: endpoint.ref, launchId: endpoint.launchId });
        if (this.active.get(terminalId) === endpoint) this.active.delete(terminalId);
    }

    /**
     * Exposes the Server-issued identity after preparation but before PTY spawn so Server can bind pre-launch evidence
     * to the exact generation without exposing its credential token.
     */
    preparedEndpointForTerminal(terminalId: string): AgentControlTarget | undefined {
        const endpoint = this.active.get(terminalId);
        return endpoint && !endpoint.retiring
            ? { launchId: endpoint.launchId, ref: endpoint.ref, terminalId: endpoint.terminalId }
            : undefined;
    }

    endpointForTerminal(terminalId: string): AgentControlTarget | undefined {
        const endpoint = this.active.get(terminalId);
        return endpoint?.activated && !endpoint.retiring
            ? { launchId: endpoint.launchId, ref: endpoint.ref, terminalId: endpoint.terminalId }
            : undefined;
    }

    /**
     * Resolves an exact live Endpoint generation before a Server-owned PTY side effect.
     */
    controlTarget(reference: AgentEndpointReference): AgentControlTarget {
        const endpoint = this.active
            .values()
            .find(
                (candidate) =>
                    candidate.activated &&
                    !candidate.retiring &&
                    candidate.ref.hostId === reference.hostId &&
                    candidate.ref.endpointId === reference.endpointId &&
                    candidate.ref.generation === reference.generation,
            );
        if (!endpoint) throw new CaxriError('UNAVAILABLE', 'Agent Endpoint is unavailable');
        return { launchId: endpoint.launchId, ref: endpoint.ref, terminalId: endpoint.terminalId };
    }

    isCurrent(target: AgentControlTarget): boolean {
        const current = this.active.get(target.terminalId);
        return Boolean(
            current?.activated &&
            !current.retiring &&
            current.launchId === target.launchId &&
            current.ref.endpointId === target.ref.endpointId &&
            current.ref.generation === target.ref.generation,
        );
    }

    async close(): Promise<void> {
        await Promise.allSettled(this.active.keys().map((terminalId) => this.retire(terminalId)));
    }
}
