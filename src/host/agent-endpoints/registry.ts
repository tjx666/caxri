import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
    agentEndpointBeginParamsSchema,
    agentEndpointBeginResultSchema,
    agentEndpointRetireParamsSchema,
    type AgentEndpointBeginParams,
    type AgentEndpointBeginResult,
    type AgentEndpointRetireParams,
} from '../../shared/ipc/agent-endpoint-control';
import type {
    AgentContextResult,
    AgentDeliveryMode,
    AgentEndpointGrant,
    AgentEndpointRef,
    AgentEndpointSummary,
    AgentGrantPolicy,
} from '../../shared/ipc/agent-endpoint-contract';
import { CaxriError } from '../../shared/ipc/errors';
import {
    capabilityIds,
    type Capability,
    type CommandExecutionContext,
} from '../../shared/ipc/principal';

const ENDPOINT_TTL_MS = 24 * 60 * 60 * 1_000;

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
} as const satisfies Record<AgentGrantPolicy, readonly Capability[]>;

interface StoredEndpoint {
    expiresAt: number;
    grants: Map<string, AgentEndpointGrant>;
    launchId: string;
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
    now?: () => number;
    token?: () => string;
}

export type AgentEndpointRetiredListener = (endpoint: AgentEndpointSummary) => void;

function tokenDigest(token: string): Buffer {
    return createHash('sha256').update(token).digest();
}

function capabilitiesFor(record: StoredEndpoint, now: number): Capability[] {
    const granted = new Set<Capability>(BASELINE_CAPABILITIES);
    for (const grant of record.grants.values()) {
        if (grant.expiresAt <= now) continue;
        for (const capability of GRANT_CAPABILITIES[grant.policy]) granted.add(capability);
    }
    return capabilityIds.filter((capability) => granted.has(capability));
}

/** Host-memory authority for one directly managed Agent PTY generation. */
export class AgentEndpointRegistry {
    private readonly byEndpoint = new Map<string, StoredEndpoint>();
    private readonly byTerminal = new Map<string, StoredEndpoint>();
    private readonly generations = new Map<string, number>();
    private readonly retiredListeners = new Set<AgentEndpointRetiredListener>();
    private readonly now: () => number;
    private readonly token: () => string;

    constructor(
        private readonly hostId: string,
        options: AgentEndpointRegistryOptions = {},
    ) {
        this.now = options.now ?? Date.now;
        this.token = options.token ?? (() => randomBytes(32).toString('hex'));
    }

    begin(raw: AgentEndpointBeginParams): AgentEndpointBeginResult {
        const input = agentEndpointBeginParamsSchema.parse(raw);
        this.retireTerminal(input.terminalId);
        const generation = (this.generations.get(input.terminalId) ?? 0) + 1;
        this.generations.set(input.terminalId, generation);
        const token = this.token();
        const expiresAt = this.now() + ENDPOINT_TTL_MS;
        const ref = {
            hostId: this.hostId,
            endpointId: randomUUID(),
            generation,
        } satisfies AgentEndpointRef;
        const summary = {
            ref,
            projectId: input.projectId,
            sessionId: input.sessionId,
            terminalId: input.terminalId,
            provider: input.provider,
            name: input.name,
            permissionClass: input.permissionClass,
            deliveryMode: input.deliveryMode,
            expiresAt,
        } satisfies AgentEndpointSummary;
        const record: StoredEndpoint = {
            expiresAt,
            grants: new Map(),
            launchId: input.launchId,
            summary,
            terminalId: input.terminalId,
            tokenDigest: tokenDigest(token),
        };
        this.byEndpoint.set(ref.endpointId, record);
        this.byTerminal.set(input.terminalId, record);
        return agentEndpointBeginResultSchema.parse({ ref, token, expiresAt });
    }

    retire(raw: AgentEndpointRetireParams): boolean {
        const input = agentEndpointRetireParamsSchema.parse(raw);
        const record = this.byEndpoint.get(input.ref.endpointId);
        if (!record || !this.matches(record, input.ref) || record.launchId !== input.launchId)
            return false;
        this.remove(record);
        return true;
    }

    retireTerminal(terminalId: string): void {
        const record = this.byTerminal.get(terminalId);
        if (record) this.remove(record);
    }

    retireSession(sessionId: string): void {
        this.retireWhere((record) => record.summary.sessionId === sessionId);
    }

    retireProject(projectId: string): void {
        this.retireWhere((record) => record.summary.projectId === projectId);
    }

    clear(): void {
        for (const record of [...this.byEndpoint.values()]) this.remove(record);
    }

    /** Lets Host-owned generation resources expire at exactly the same endpoint boundary. */
    onRetired(listener: AgentEndpointRetiredListener): () => void {
        this.retiredListeners.add(listener);
        return () => this.retiredListeners.delete(listener);
    }

    authenticate(credential: AgentEndpointCredential): CommandExecutionContext {
        const record = this.active(credential.endpointId);
        const candidate = tokenDigest(credential.token);
        if (
            credential.hostId !== this.hostId ||
            !record ||
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
        return [...this.byEndpoint.values()]
            .filter((record) => !projectIds || projectIds.has(record.summary.projectId))
            .map((record) => record.summary)
            .sort((left, right) => left.ref.endpointId.localeCompare(right.ref.endpointId));
    }

    grants(ref: AgentEndpointRef): AgentEndpointGrant[] {
        return this.activeGrants(this.exact(ref));
    }

    grant(ref: AgentEndpointRef, policy: AgentGrantPolicy, ttlMs: number): AgentEndpointGrant {
        const record = this.exact(ref);
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

    revoke(ref: AgentEndpointRef, grantId: string): boolean {
        return this.exact(ref).grants.delete(grantId);
    }

    updateDelivery(ref: AgentEndpointRef, deliveryMode: AgentDeliveryMode): void {
        const record = this.exact(ref);
        record.summary = { ...record.summary, deliveryMode };
    }

    resolve(ref: AgentEndpointRef): AgentEndpointSummary {
        return this.exact(ref).summary;
    }

    private exact(ref: AgentEndpointRef): StoredEndpoint {
        const record = this.active(ref.endpointId);
        if (!record || !this.matches(record, ref))
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint is unavailable');
        return record;
    }

    private active(endpointId: string): StoredEndpoint | undefined {
        const record = this.byEndpoint.get(endpointId);
        if (record && record.expiresAt <= this.now()) {
            this.remove(record);
            return undefined;
        }
        return record;
    }

    private activeGrants(record: StoredEndpoint): AgentEndpointGrant[] {
        const now = this.now();
        for (const [id, grant] of record.grants) {
            if (grant.expiresAt <= now) record.grants.delete(id);
        }
        return [...record.grants.values()].sort((left, right) => left.id.localeCompare(right.id));
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

    private matches(record: StoredEndpoint, ref: AgentEndpointRef): boolean {
        return (
            ref.hostId === this.hostId &&
            record.summary.ref.endpointId === ref.endpointId &&
            record.summary.ref.generation === ref.generation
        );
    }

    private retireWhere(predicate: (record: StoredEndpoint) => boolean): void {
        for (const record of [...this.byEndpoint.values()]) {
            if (predicate(record)) this.remove(record);
        }
    }

    private sweep(): void {
        for (const record of [...this.byEndpoint.values()]) {
            if (record.expiresAt <= this.now()) this.remove(record);
        }
    }

    private remove(record: StoredEndpoint): void {
        this.byEndpoint.delete(record.summary.ref.endpointId);
        if (this.byTerminal.get(record.terminalId) === record)
            this.byTerminal.delete(record.terminalId);
        record.grants.clear();
        record.tokenDigest.fill(0);
        for (const listener of this.retiredListeners) listener(record.summary);
    }
}
