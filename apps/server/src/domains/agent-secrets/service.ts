import type {
    AgentSecretRequestStatus,
    AgentSecretScope,
    AgentSecretSummary,
    MethodResult,
    ServerEvent,
    ServerOperationParameters,
} from '@caxri/protocol';
import { CaxriError, errorMessage, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import { AgentSecretRequests } from './requests';
import { AgentSecretStore } from './store';

export interface AgentSecretServiceOptions {
    database: Pick<CaxriDatabase, 'getProject' | 'getTerminal'>;
    logger: StructuredLogger;
    send: (event: ServerEvent) => void;
    userDataPath: string;
    now?: () => number;
}

type Caller = ServerOperationParameters<'agent.secret.requestInternal'>['caller'];

function isInScope(scope: AgentSecretScope, projectId: string): boolean {
    return scope.kind === 'global' || scope.projectId === projectId;
}

/**
 * Owns the user's Agent secrets and the requests Agents raise for missing ones. Desktop manages the store; an Agent
 * reaches it only through its Endpoint's Project (see `agent-command-request.ts`), never by naming a Project.
 */
export class AgentSecretService {
    private readonly now: () => number;
    readonly store: AgentSecretStore;
    readonly requests: AgentSecretRequests;

    constructor(private readonly options: AgentSecretServiceOptions) {
        this.now = options.now ?? Date.now;
        this.store = new AgentSecretStore(options.userDataPath, this.now);
        this.requests = new AgentSecretRequests(() => this.changed(), this.now);
    }

    private changed(): void {
        this.options.send({ event: 'agentSecrets.changed', payload: {} });
    }

    /**
     * The Project whose secrets an Agent sees: a worktree Project Caxri registered on another Project's behalf shares
     * its owner's secrets, so a secret saved for a repository keeps working in every worktree of it.
     */
    private secretProject(caller: Caller): Caller {
        const project = this.options.database.getProject(caller.projectId);
        return project?.ownerProjectId ? { ...caller, projectId: project.ownerProjectId } : caller;
    }

    private requireProject(projectId: string): void {
        if (!this.options.database.getProject(projectId))
            throw new CaxriError('NOT_FOUND', 'Project not found');
    }

    private logSettled(requestId: string, status: AgentSecretRequestStatus): void {
        const request = this.requests.get(requestId);
        this.options.logger.write('info', logEventCatalog.agentSecrets.settled, {
            fields: {
                status,
                ...(request && { durationMs: this.now() - request.createdAt }),
            },
        });
    }

    async list(): Promise<AgentSecretSummary[]> {
        return this.store.list();
    }

    async set(
        name: string,
        scope: AgentSecretScope,
        value: string,
        source: 'settings' | 'request' = 'settings',
    ): Promise<AgentSecretSummary> {
        if (scope.kind === 'project') this.requireProject(scope.projectId);
        const saved = await this.store.set(name, scope, value);
        this.options.logger.write('info', logEventCatalog.agentSecrets.saved, {
            fields: { kind: scope.kind, source },
        });
        const satisfied = this.requests.satisfy(name, (projectId) => isInScope(scope, projectId));
        for (const requestId of satisfied) this.logSettled(requestId, 'saved');
        this.changed();
        return saved;
    }

    async delete(name: string, scope: AgentSecretScope): Promise<boolean> {
        const deleted = await this.store.delete(name, scope);
        if (deleted) this.changed();
        return deleted;
    }

    async answer(
        parameters: ServerOperationParameters<'secrets.requests.answer'>,
    ): Promise<MethodResult<'secrets.requests.answer'>> {
        const request = this.requests.get(parameters.requestId);
        if (request?.status !== 'pending')
            throw new CaxriError(
                request ? 'CONFLICT' : 'NOT_FOUND',
                request ? 'This secret request is no longer waiting' : 'Secret request not found',
            );
        const { answer } = parameters;
        if (answer.action === 'save') {
            const scope: AgentSecretScope =
                answer.scope === 'global'
                    ? { kind: 'global' }
                    : { kind: 'project', projectId: request.projectId };
            /**
             * Saving settles every pending request the secret now covers, this one included, so a second card asking
             * for the same name closes too. The value is kept even when this request expired during the write.
             */
            await this.set(request.name, scope, answer.value, 'request');
            return { status: 'saved' };
        }
        this.requests.answer(request.id, 'declined');
        this.logSettled(request.id, 'declined');
        return { status: 'declined' };
    }

    async visible(endpoint: Caller): Promise<MethodResult<'agent.secret.list'>> {
        const caller = this.secretProject(endpoint);
        const visible = await this.store.visible(caller.projectId);
        return {
            secrets: visible
                .values()
                .map(({ name, scope }) => ({ name, scope: scope.kind }))
                .toArray()
                .toSorted((left, right) => left.name.localeCompare(right.name)),
        };
    }

    async request(
        parameters: ServerOperationParameters<'agent.secret.requestInternal'>,
    ): Promise<MethodResult<'agent.secret.request'>> {
        const { name, reason } = parameters;
        const caller = this.secretProject(parameters.caller);
        const visible = await this.store.visible(caller.projectId);
        if (visible.has(name)) {
            this.options.logger.write('info', logEventCatalog.agentSecrets.requested, {
                fields: { outcome: 'available' },
            });
            return { status: 'available' };
        }
        const terminal = this.options.database.getTerminal(caller.terminalId);
        if (!terminal) throw new CaxriError('NOT_FOUND', 'Agent Terminal not found');
        const pendingBefore = this.requests.pending().length;
        const request = this.requests.offer({
            name,
            reason,
            projectId: caller.projectId,
            sessionId: terminal.sessionId,
            terminalId: caller.terminalId,
        });
        this.options.logger.write('info', logEventCatalog.agentSecrets.requested, {
            fields: {
                outcome: this.requests.pending().length > pendingBefore ? 'raised' : 'joined',
            },
        });
        return { status: 'pending', requestId: request.id };
    }

    async wait(
        parameters: ServerOperationParameters<'agent.secret.waitInternal'>,
        signal?: AbortSignal,
    ): Promise<MethodResult<'agent.secret.wait'>> {
        const before = this.requests.get(parameters.requestId)?.status;
        const status = await this.requests.wait(
            parameters.caller.terminalId,
            parameters.requestId,
            parameters.timeoutMs,
            signal,
        );
        /**
         * The Agent-side end of a request (expired or withdrawn) is logged once, by the poll that first observes it; a
         * user answer is logged where it happens.
         */
        if (before === 'pending' && (status === 'expired' || status === 'cancelled'))
            this.logSettled(parameters.requestId, status);
        return { status };
    }

    async resolve(
        parameters: ServerOperationParameters<'agent.secret.resolveInternal'>,
    ): Promise<MethodResult<'agent.secret.resolve'>> {
        const visible = await this.store.visible(this.secretProject(parameters.caller).projectId);
        const values: Record<string, string> = {};
        for (const name of parameters.names) {
            const secret = visible.get(name);
            if (secret) values[name] = secret.value;
        }
        const found = Object.keys(values).length;
        this.options.logger.write('info', logEventCatalog.agentSecrets.resolved, {
            fields: { requested: parameters.names.length, found },
        });
        const missing = parameters.names.filter((name) => !(name in values));
        if (missing.length > 0)
            throw new CaxriError(
                'NOT_FOUND',
                `No secret named ${missing.join(', ')} for this Project. Run \`caxri secret request ${missing[0]} --reason "<why>"\` to ask the user.`,
                { missing },
            );
        return { values };
    }

    /**
     * Drops the secrets of deleted Projects, including the worktree Projects a deleted Project owned.
     */
    async pruneDeletedProjects(): Promise<void> {
        try {
            const removed = await this.store.pruneProjects(
                (projectId) => this.options.database.getProject(projectId) !== undefined,
            );
            this.options.logger.write('info', logEventCatalog.agentSecrets.projectPruned, {
                fields: { removed },
            });
            if (removed > 0) this.changed();
        } catch (error) {
            this.options.logger.write('warn', logEventCatalog.agentSecrets.projectPruned, {
                fields: { error: errorMessage(error, 'unknown') },
            });
        }
    }

    close(): void {
        this.requests.close();
    }
}
