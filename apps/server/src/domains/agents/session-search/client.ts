import { Worker } from 'node:worker_threads';

import type { AgentProvider } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentEnvironment } from '../contract';
import type { ConversationExclusionReason } from '../external-conversation-parsers';
import { conversationExclusionReasons } from '../external-conversation-parsers';
import type { IndexSearchRequest, IndexSearchResponse, IndexStatus } from './engine';
import type {
    ConversationIdentity,
    InspectedConversation,
    SessionSearchWorkerData,
    SessionSearchWorkerReply,
    SessionSearchWorkerRequest,
} from './worker-protocol';

/**
 * The Worker holds the index's page cache and a parsed copy of every hot transcript; an idle one is released.
 */
const IDLE_TIMEOUT_MS = 60_000;
/**
 * After the index could not be opened, searches answer without it for this long before trying again.
 */
const UNAVAILABLE_RETRY_MS = 60_000;

/**
 * The subset of `node:worker_threads` `Worker` the client drives, so tests can supply an in-process double.
 */
interface SessionSearchWorkerHandle {
    postMessage(message: SessionSearchWorkerRequest): void;
    on(event: 'message', listener: (reply: SessionSearchWorkerReply) => void): unknown;
    on(event: 'error', listener: (error: unknown) => void): unknown;
    on(event: 'exit', listener: (code: number) => void): unknown;
    terminate(): Promise<number>;
}

interface SessionSearchIndexOptions {
    databasePath: string;
    environment: AgentEnvironment;
    logger: Pick<StructuredLogger, 'write'>;
    /**
     * Bundled `session-search-worker.js`. Without it (or `createWorker`), the index is unavailable and search falls
     * back to Caxri Sessions only.
     */
    workerPath?: string;
    createWorker?: (data: SessionSearchWorkerData) => SessionSearchWorkerHandle;
    idleTimeoutMs?: number;
    now?: () => number;
}

/**
 * The index could not answer: it is unavailable, the Worker crashed, or the request failed. Callers degrade instead of
 * failing the whole search.
 */
export class SessionSearchIndexUnavailableError extends Error {
    constructor() {
        super('Session search index is unavailable');
        this.name = 'SessionSearchIndexUnavailableError';
    }
}

/**
 * The caller's abort reason when it is an Error (fetch-style `AbortError` or a custom one), else a standard one.
 */
/**
 * One count per exclusion reason (`excludedOversizedRecord`, ...), zeros included, so a log query can sum any cause
 * across passes without knowing which ones occurred.
 */
export function excludedFields(
    excluded: Partial<Record<ConversationExclusionReason, number>>,
): Record<string, number> {
    return Object.fromEntries(
        conversationExclusionReasons.map((reason) => [
            `excluded${reason[0].toUpperCase()}${reason.slice(1)}`,
            excluded[reason] ?? 0,
        ]),
    );
}

function abortError(signal: AbortSignal | undefined): Error {
    const reason: unknown = signal?.reason;
    return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
}

interface PendingRequest {
    resolve: (reply: SessionSearchWorkerReply) => void;
    reject: (error: Error) => void;
}

/**
 * Server Core's handle on the Session search Worker. Starts it on the first request, routes replies by request id,
 * cancels superseded searches, logs its content-free pass reports, and terminates it once idle.
 */
export class SessionSearchIndex {
    private worker: SessionSearchWorkerHandle | undefined;

    private readonly pending = new Map<number, PendingRequest>();

    private nextId = 1;

    private idleTimer: NodeJS.Timeout | undefined;

    private lastStatus: IndexStatus | undefined;

    private unavailableUntil = -Infinity;

    private requestCount = 0;

    private isClosed = false;

    constructor(private readonly options: SessionSearchIndexOptions) {}

    private request(
        build: (id: number) => SessionSearchWorkerRequest,
        signal?: AbortSignal,
    ): Promise<SessionSearchWorkerReply> {
        if (signal?.aborted) return Promise.reject(abortError(signal));
        const worker = this.ensureWorker();
        if (!worker) return Promise.reject(new SessionSearchIndexUnavailableError());
        const id = this.nextId++;
        this.requestCount += 1;
        this.clearIdleTimer();
        return new Promise<SessionSearchWorkerReply>((resolve, reject) => {
            const onAbort = () => {
                if (!this.pending.delete(id)) return;
                worker.postMessage({ id, type: 'cancel' });
                this.scheduleIdle();
                reject(abortError(signal));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.pending.set(id, {
                resolve: (reply) => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve(reply);
                },
                reject: (error) => {
                    signal?.removeEventListener('abort', onAbort);
                    reject(error);
                },
            });
            worker.postMessage(build(id));
        });
    }

    private ensureWorker(): SessionSearchWorkerHandle | undefined {
        if (this.worker) return this.worker;
        if (this.isClosed || this.now() < this.unavailableUntil) return;
        const data: SessionSearchWorkerData = {
            databasePath: this.options.databasePath,
            environment: this.options.environment,
        };
        const { createWorker, workerPath } = this.options;
        let worker: SessionSearchWorkerHandle;
        if (createWorker) worker = createWorker(data);
        else if (workerPath) worker = new Worker(workerPath, { workerData: data });
        else return;
        this.worker = worker;
        this.requestCount = 0;
        worker.on('message', (reply) => this.receive(worker, reply));
        worker.on('error', () => this.exited(worker, 'crashed'));
        worker.on('exit', () => this.exited(worker, 'crashed'));
        return worker;
    }

    private receive(worker: SessionSearchWorkerHandle, reply: SessionSearchWorkerReply): void {
        if (worker !== this.worker) return;
        const { logger } = this.options;
        switch (reply.type) {
            case 'pass': {
                this.lastStatus = reply.status;
                const { durationMs, excluded, ...counts } = reply.report;
                // A record past the head read's caps hides a real conversation, so it is as loud as a failed file.
                const isLossy = counts.failed > 0 || (excluded.oversizedRecord ?? 0) > 0;
                logger.write(isLossy ? 'warn' : 'debug', logEventCatalog.sessionSearch.indexPass, {
                    durationMs,
                    fields: {
                        ...counts,
                        ...excludedFields(excluded),
                        conversations: reply.status.conversations,
                    },
                });
                this.scheduleIdle();
                return;
            }
            case 'passFailed': {
                this.lastStatus = reply.status;
                logger.write('warn', logEventCatalog.sessionSearch.indexPassFailed, {});
                this.scheduleIdle();
                return;
            }
            case 'unavailable': {
                logger.write('warn', logEventCatalog.sessionSearch.indexUnavailable, {});
                this.unavailableUntil = this.now() + UNAVAILABLE_RETRY_MS;
                // eslint-disable-next-line no-void -- termination is best-effort; pending requests already failed
                void this.stop('unavailable');
                return;
            }
            case 'error': {
                const request = this.pending.get(reply.id);
                this.pending.delete(reply.id);
                request?.reject(new SessionSearchIndexUnavailableError());
                this.scheduleIdle();
                return;
            }
            default: {
                const request = this.pending.get(reply.id);
                this.pending.delete(reply.id);
                request?.resolve(reply);
                this.scheduleIdle();
            }
        }
    }

    private exited(worker: SessionSearchWorkerHandle, reason: 'crashed'): void {
        if (worker !== this.worker) return;
        this.worker = undefined;
        this.finish(reason);
    }

    private async stop(reason: 'idle' | 'shutdown' | 'unavailable'): Promise<void> {
        const { worker } = this;
        if (!worker) return;
        this.worker = undefined;
        this.finish(reason);
        await worker.terminate();
    }

    private finish(reason: 'crashed' | 'idle' | 'shutdown' | 'unavailable'): void {
        this.clearIdleTimer();
        this.lastStatus = undefined;
        for (const request of this.pending.values())
            request.reject(new SessionSearchIndexUnavailableError());
        this.pending.clear();
        this.options.logger.write(
            reason === 'crashed' ? 'warn' : 'debug',
            logEventCatalog.sessionSearch.workerExited,
            { fields: { reason, requests: this.requestCount } },
        );
    }

    /**
     * A Worker still indexing keeps running so the first build finishes in the background; otherwise it is released
     * after the idle timeout.
     */
    private scheduleIdle(): void {
        this.clearIdleTimer();
        if (!this.worker || this.pending.size > 0) return;
        this.idleTimer = setTimeout(() => {
            this.idleTimer = undefined;
            if (this.lastStatus?.state === 'indexing') {
                this.scheduleIdle();
                return;
            }
            // eslint-disable-next-line no-void -- termination is best-effort; nothing waits on an idle stop
            void this.stop('idle');
        }, this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
        this.idleTimer.unref();
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    async search(request: IndexSearchRequest, signal?: AbortSignal): Promise<IndexSearchResponse> {
        const reply = await this.request((id) => ({ id, type: 'search', request }), signal);
        if (reply.type !== 'search') throw new SessionSearchIndexUnavailableError();
        this.lastStatus = reply.response.status;
        return reply.response;
    }

    /**
     * Reads one conversation's folder, title, and last activity straight from its transcript, so importing never trusts
     * an index row that may predate a rename or a move.
     */
    async inspect(
        provider: AgentProvider,
        agentSessionId: string,
    ): Promise<InspectedConversation | undefined> {
        const reply = await this.request((id) => ({
            id,
            type: 'inspect',
            provider,
            agentSessionId,
        }));
        if (reply.type !== 'inspect') throw new SessionSearchIndexUnavailableError();
        return reply.conversation;
    }

    /**
     * Indexed titles of conversations Caxri already knows, aligned with `conversations`. Answers from the index alone,
     * so it is cheap enough for a hover card, and may lag a rename the next index pass has not seen.
     */
    async describe(
        conversations: ConversationIdentity[],
        signal?: AbortSignal,
    ): Promise<Array<string | undefined>> {
        if (conversations.length === 0) return [];
        const reply = await this.request((id) => ({ id, type: 'describe', conversations }), signal);
        if (reply.type !== 'describe') throw new SessionSearchIndexUnavailableError();
        return reply.titles;
    }

    async close(): Promise<void> {
        this.isClosed = true;
        await this.stop('shutdown');
    }
}
