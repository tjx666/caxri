import type { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type {
    AgentContextResult,
    AgentEndpointActivateParams as AgentEndpointActivateParameters,
    AgentEndpointBeginParams as AgentEndpointBeginParameters,
    AgentEndpointBeginResult,
    AgentEndpointGrant,
    AgentEndpointMessagingParams as AgentEndpointMessagingParameters,
    AgentEndpointRef as AgentEndpointReference,
    AgentEndpointRetireParams as AgentEndpointRetireParameters,
    AgentEndpointSummary,
    AgentGrantPolicy,
    Capability,
    CommandExecutionContext,
} from '@caxri/protocol';
import {
    agentEndpointActivateParamsSchema as agentEndpointActivateParametersSchema,
    agentEndpointBeginParamsSchema as agentEndpointBeginParametersSchema,
    agentEndpointBeginResultSchema,
    agentEndpointMessagingParamsSchema as agentEndpointMessagingParametersSchema,
    agentEndpointRetireParamsSchema as agentEndpointRetireParametersSchema,
    capabilityIds,
    CaxriError,
    errorMessage,
    logEventCatalog,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { notifyListeners } from '@caxri/utils';

const ENDPOINT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_RETIRED_ENDPOINTS = 256;

const BASELINE_CAPABILITIES = [
    'agents.read',
    'agents.message',
    'projects.read',
    'sessions.read',
    'terminals.read',
] as const satisfies readonly Capability[];

const GRANT_CAPABILITIES = {
    'debug:read': ['diagnostics.read', 'events.read', 'settings.read'],
    'business:write': ['settings.write'],
    'agent:control': ['agents.control', 'agents.dispatch'],
    'agent:delegate': ['agents.delegate', 'agents.read'],
} as const satisfies Record<AgentGrantPolicy, readonly Capability[]>;

interface StoredEndpoint {
    activated: boolean;
    expiresAt: number;
    grants: Map<string, AgentEndpointGrant>;
    launchId: string;
    role?: 'commander';
    summary: AgentEndpointSummary;
    terminalId: string;
    tokenDigest: Buffer;
}

export interface AgentEndpointCredential {
    hostId: string;
    endpointId: string;
    generation: number;
    token: string;
}

export interface AgentEndpointRegistryOptions {
    /**
     * Reports a retired/messagingChanged listener's failure, isolated so it cannot stop delivery to the rest. Only the
     * failure reason is logged, never the endpoint summary.
     */
    logger?: StructuredLogger;
    now?: () => number;
    token?: () => string;
}

/**
 * Generation fencing state must outlive the endpoint record so a same-Terminal restart keeps a monotonic generation,
 * but it carries its owning scope so permanent Terminal/Session/Project deletion can recycle it and keep long-lived
 * Hosts bounded.
 */
interface GenerationRecord {
    generation: number;
    projectId: string;
    sessionId: string;
}

export type AgentEndpointRetiredListener = (endpoint: AgentEndpointSummary) => void;
export type AgentEndpointMessagingChangedListener = (
    endpoint: AgentEndpointSummary,
    previous: AgentEndpointSummary['messaging'],
) => void;

function tokenDigest(token: string): Buffer {
    return createHash('sha256').update(token).digest();
}

/**
 * Fixed authority of the Agent Commander Terminal: read the cross-Project board, create empty Sessions, and delegate
 * into them. Target Sessions are authorized per request by domain services, so the principal's Project scope stays the
 * Commander's own system Project and never widens to control or dispatch.
 */
const COMMANDER_CAPABILITIES = [
    'agents.delegate',
    'commander',
] as const satisfies readonly Capability[];

function capabilitiesFor(record: StoredEndpoint, now: number): Capability[] {
    const granted = new Set<Capability>(BASELINE_CAPABILITIES);
    if (record.role === 'commander')
        for (const capability of COMMANDER_CAPABILITIES) granted.add(capability);
    for (const grant of record.grants.values()) {
        if (grant.expiresAt <= now) continue;
        const capabilitiesForPolicy = GRANT_CAPABILITIES[grant.policy];
        for (const capability of capabilitiesForPolicy) granted.add(capability);
    }
    return capabilityIds.filter((capability) => granted.has(capability));
}

/**
 * Server Core in-memory authority for one directly managed Agent PTY generation.
 */
export class AgentEndpointRegistry {
    private readonly byEndpoint = new Map<string, StoredEndpoint>();
    private readonly byTerminal = new Map<string, StoredEndpoint>();
    private readonly generations = new Map<string, GenerationRecord>();
    private readonly logger?: StructuredLogger;
    private readonly messagingChangedListeners = new Set<AgentEndpointMessagingChangedListener>();
    private readonly retiredListeners = new Set<AgentEndpointRetiredListener>();
    private readonly retired = new Map<string, AgentEndpointSummary>();
    private readonly now: () => number;
    private readonly token: () => string;

    constructor(
        private readonly hostId: string,
        options: AgentEndpointRegistryOptions = {},
    ) {
        this.now = options.now ?? Date.now;
        this.token = options.token ?? (() => randomBytes(32).toString('hex'));
        this.logger = options.logger;
    }

    private exact(reference: AgentEndpointReference): StoredEndpoint {
        const record = this.active(reference.endpointId);
        if (!record || !this.matches(record, reference))
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint is unavailable');
        return record;
    }

    private active(endpointId: string): StoredEndpoint | undefined {
        const record = this.byEndpoint.get(endpointId);
        if (record && record.expiresAt <= this.now()) {
            this.remove(record);
            return undefined;
        }
        return record?.activated ? record : undefined;
    }

    private activeGrants(record: StoredEndpoint): AgentEndpointGrant[] {
        const now = this.now();
        for (const [id, grant] of record.grants) {
            if (grant.expiresAt <= now) record.grants.delete(id);
        }
        return record.grants
            .values()
            .toArray()
            .toSorted((left, right) => left.id.localeCompare(right.id));
    }

    private executionContext(record: StoredEndpoint): CommandExecutionContext {
        const now = this.now();
        this.activeGrants(record);
        return {
            capabilities: capabilitiesFor(record, now),
            principal: {
                kind: 'agent',
                id: `agent:${record.summary.ref.endpointId}`,
                endpointId: record.summary.ref.endpointId,
                generation: record.summary.ref.generation,
                projectIds: [record.summary.projectId],
            },
        };
    }

    private matches(record: StoredEndpoint, reference: AgentEndpointReference): boolean {
        return (
            reference.hostId === this.hostId &&
            record.summary.ref.endpointId === reference.endpointId &&
            record.summary.ref.generation === reference.generation
        );
    }

    private retireWhere(shouldRetire: (record: StoredEndpoint) => boolean): void {
        for (const record of this.byEndpoint.values()) {
            if (shouldRetire(record)) this.remove(record);
        }
    }

    private forgetGenerationsWhere(shouldForget: (record: GenerationRecord) => boolean): void {
        for (const [terminalId, record] of this.generations) {
            if (shouldForget(record)) this.generations.delete(terminalId);
        }
    }

    private sweep(): void {
        for (const record of this.byEndpoint.values()) {
            if (record.expiresAt <= this.now()) this.remove(record);
        }
    }

    private remove(record: StoredEndpoint): void {
        this.byEndpoint.delete(record.summary.ref.endpointId);
        if (this.byTerminal.get(record.terminalId) === record)
            this.byTerminal.delete(record.terminalId);
        record.grants.clear();
        record.tokenDigest.fill(0);
        this.retired.delete(record.summary.ref.endpointId);
        this.retired.set(record.summary.ref.endpointId, record.summary);
        while (this.retired.size > MAX_RETIRED_ENDPOINTS)
            this.retired.delete(this.retired.keys().next().value!);
        // Isolates each retired-endpoint subscriber so one throwing listener cannot stop the rest from observing this
        // retirement; only the failure reason is logged, never the endpoint summary.
        notifyListeners(this.retiredListeners, record.summary, (error) =>
            this.logger?.write('warn', logEventCatalog.agentEndpoint.retiredListenerFailed, {
                fields: { error: errorMessage(error, 'unknown') },
            }),
        );
    }

    begin(raw: AgentEndpointBeginParameters): AgentEndpointBeginResult {
        const input = agentEndpointBeginParametersSchema.parse(raw);
        this.retireTerminal(input.terminalId);
        const generation = (this.generations.get(input.terminalId)?.generation ?? 0) + 1;
        this.generations.set(input.terminalId, {
            generation,
            projectId: input.projectId,
            sessionId: input.sessionId,
        });
        const token = this.token();
        const expiresAt = this.now() + ENDPOINT_TTL_MS;
        const reference = {
            hostId: this.hostId,
            endpointId: randomUUID(),
            generation,
        } satisfies AgentEndpointReference;
        const summary = {
            ref: reference,
            projectId: input.projectId,
            sessionId: input.sessionId,
            terminalId: input.terminalId,
            provider: input.provider,
            name: input.name,
            permissionClass: input.permissionClass,
            messaging: input.messaging,
            expiresAt,
        } satisfies AgentEndpointSummary;
        const record: StoredEndpoint = {
            activated: false,
            expiresAt,
            grants: new Map(),
            launchId: input.launchId,
            role: input.role,
            summary,
            terminalId: input.terminalId,
            tokenDigest: tokenDigest(token),
        };
        this.byEndpoint.set(reference.endpointId, record);
        this.byTerminal.set(input.terminalId, record);
        return agentEndpointBeginResultSchema.parse({ ref: reference, token, expiresAt });
    }

    /**
     * Makes a prepared credential externally reachable only after domain services confirm its PTY exists.
     */
    activate(raw: AgentEndpointActivateParameters): boolean {
        const input = agentEndpointActivateParametersSchema.parse(raw);
        const record = this.byEndpoint.get(input.ref.endpointId);
        if (!record || !this.matches(record, input.ref) || record.launchId !== input.launchId)
            return false;
        if (record.expiresAt <= this.now()) {
            this.remove(record);
            return false;
        }
        record.activated = true;
        return true;
    }

    retire(raw: AgentEndpointRetireParameters): boolean {
        const input = agentEndpointRetireParametersSchema.parse(raw);
        const record = this.byEndpoint.get(input.ref.endpointId);
        if (!record || !this.matches(record, input.ref) || record.launchId !== input.launchId)
            return false;
        this.remove(record);
        return true;
    }

    /**
     * Temporary retirement (restart, PTY exit, domain reset): the Terminal identity survives, so its generation record
     * must survive to keep the next `begin()` monotonic.
     */
    retireTerminal(terminalId: string): void {
        const record = this.byTerminal.get(terminalId);
        if (record) this.remove(record);
    }

    /**
     * Permanent deletion: recycles the generation record together with the active endpoint.
     */
    forgetTerminal(terminalId: string): void {
        this.retireTerminal(terminalId);
        this.generations.delete(terminalId);
    }

    forgetSession(sessionId: string): void {
        this.retireWhere((record) => record.summary.sessionId === sessionId);
        this.forgetGenerationsWhere((record) => record.sessionId === sessionId);
    }

    forgetProject(projectId: string): void {
        this.retireWhere((record) => record.summary.projectId === projectId);
        this.forgetGenerationsWhere((record) => record.projectId === projectId);
    }

    clear(): void {
        for (const record of this.byEndpoint.values()) this.remove(record);
    }

    /**
     * Lets Server-owned generation resources expire at exactly the same endpoint boundary.
     */
    onRetired(listener: AgentEndpointRetiredListener): () => void {
        this.retiredListeners.add(listener);
        return () => this.retiredListeners.delete(listener);
    }

    onMessagingChanged(listener: AgentEndpointMessagingChangedListener): () => void {
        this.messagingChangedListeners.add(listener);
        return () => this.messagingChangedListeners.delete(listener);
    }

    authenticate(credential: AgentEndpointCredential): CommandExecutionContext {
        const record = this.active(credential.endpointId);
        const candidate = tokenDigest(credential.token);
        if (
            !record ||
            credential.hostId !== this.hostId ||
            record.summary.ref.generation !== credential.generation ||
            !timingSafeEqual(candidate, record.tokenDigest)
        )
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint is unavailable');
        return this.executionContext(record);
    }

    refresh(context: CommandExecutionContext): CommandExecutionContext {
        if (context.principal.kind !== 'agent') return context;
        const record = this.active(context.principal.endpointId);
        if (!record || record.summary.ref.generation !== context.principal.generation)
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint is unavailable');
        return this.executionContext(record);
    }

    context(context: CommandExecutionContext): AgentContextResult {
        const refreshed = this.refresh(context);
        if (refreshed.principal.kind !== 'agent')
            throw new CaxriError('FORBIDDEN', 'Agent Endpoint context requires an Agent principal');
        const record = this.active(refreshed.principal.endpointId)!;
        return {
            status: 'active',
            endpoint: record.summary,
            capabilities: [...refreshed.capabilities],
            grants: this.activeGrants(record),
        };
    }

    list(context: CommandExecutionContext): AgentEndpointSummary[] {
        this.sweep();
        const projectIds =
            context.principal.kind === 'agent' ? new Set(context.principal.projectIds) : undefined;
        const endpoints: AgentEndpointSummary[] = [];
        for (const record of this.byEndpoint.values()) {
            if (record.activated && (!projectIds || projectIds.has(record.summary.projectId)))
                endpoints.push(record.summary);
        }
        return endpoints.toSorted((left, right) =>
            left.ref.endpointId.localeCompare(right.ref.endpointId),
        );
    }

    grants(reference: AgentEndpointReference): AgentEndpointGrant[] {
        return this.activeGrants(this.exact(reference));
    }

    grant(
        reference: AgentEndpointReference,
        policy: AgentGrantPolicy,
        ttlMs: number,
    ): AgentEndpointGrant {
        const record = this.exact(reference);
        for (const [id, existing] of record.grants) {
            if (existing.policy === policy) record.grants.delete(id);
        }
        const grantedAt = this.now();
        const grant = {
            id: randomUUID(),
            policy,
            grantedAt,
            expiresAt: Math.min(record.expiresAt, grantedAt + ttlMs),
        } satisfies AgentEndpointGrant;
        record.grants.set(grant.id, grant);
        return grant;
    }

    revoke(reference: AgentEndpointReference, grantId: string): boolean {
        return this.exact(reference).grants.delete(grantId);
    }

    updateMessaging(raw: AgentEndpointMessagingParameters): boolean {
        const input = agentEndpointMessagingParametersSchema.parse(raw);
        const record = this.active(input.ref.endpointId);
        if (!record || !this.matches(record, input.ref) || record.launchId !== input.launchId)
            return false;
        const previous = record.summary.messaging;
        record.summary = { ...record.summary, messaging: input.messaging };
        // Isolates each messaging-changed subscriber so one throwing listener cannot stop the rest from observing this
        // change; only the failure reason is logged, never the endpoint summary.
        notifyListeners(
            [...this.messagingChangedListeners].map(
                (listener) => () => listener(record.summary, previous),
            ),
            undefined,
            (error) =>
                this.logger?.write(
                    'warn',
                    logEventCatalog.agentEndpoint.messagingChangedListenerFailed,
                    { fields: { error: errorMessage(error, 'unknown') } },
                ),
        );
        return true;
    }

    resolve(reference: AgentEndpointReference): AgentEndpointSummary {
        return this.exact(reference).summary;
    }

    /**
     * Bounded tombstones let an explicit wake target one exact stopped generation.
     */
    resolveRetired(reference: AgentEndpointReference): AgentEndpointSummary {
        const endpoint = this.retired.get(reference.endpointId);
        if (
            !endpoint ||
            endpoint.expiresAt <= this.now() ||
            endpoint.ref.hostId !== reference.hostId ||
            endpoint.ref.generation !== reference.generation
        ) {
            if (endpoint?.expiresAt && endpoint.expiresAt <= this.now())
                this.retired.delete(reference.endpointId);
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint is unavailable');
        }
        return endpoint;
    }

    resolveTerminal(terminalId: string): AgentEndpointSummary {
        const record = this.byTerminal.get(terminalId);
        if (!record || !this.active(record.summary.ref.endpointId))
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint is unavailable');
        return record.summary;
    }
}
