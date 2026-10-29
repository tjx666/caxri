import { randomUUID } from 'node:crypto';

import type { AgentSecretRequest, AgentSecretRequestStatus } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

/**
 * How long the user has to answer before the Agent is told `expired`.
 */
export const SECRET_REQUEST_LIFETIME_MS = 15 * 60_000;
/**
 * A request nobody has polled for this long belongs to an Agent that gave up, was interrupted, or exited, so its card
 * is withdrawn. `caxri secret request` polls at most a minute apart.
 */
export const SECRET_REQUEST_ABANDON_MS = 90_000;
const SWEEP_INTERVAL_MS = 10_000;
/**
 * Settled requests stay readable this long, so an Agent whose poll raced the answer still reads the outcome.
 */
const SETTLED_RETENTION_MS = 5 * 60_000;
const MAX_PENDING_REQUESTS = 64;

type SettledStatus = Exclude<AgentSecretRequestStatus, 'pending'>;

interface Entry {
    request: AgentSecretRequest;
    lastPolledAt: number;
    settledAt?: number;
    waiters: Set<(status: SettledStatus) => void>;
}

export interface AgentSecretRequestOffer {
    name: string;
    reason: string;
    projectId: string;
    sessionId: string;
    terminalId: string;
}

/**
 * The in-memory queue of Agent secret requests. A request lives only as long as an Agent waits on it: it is never
 * persisted, so a Server Core restart withdraws every card, and the Agent's next poll reads `NOT_FOUND`.
 */
export class AgentSecretRequests {
    private readonly entries = new Map<string, Entry>();
    private readonly sweepTimer: ReturnType<typeof setInterval>;

    constructor(
        private readonly onChange: () => void,
        private readonly now: () => number = Date.now,
    ) {
        this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        this.sweepTimer.unref();
    }

    private settle(entry: Entry, status: SettledStatus): void {
        if (entry.request.status !== 'pending') return;
        entry.request = { ...entry.request, status };
        entry.settledAt = this.now();
        for (const waiter of entry.waiters) waiter(status);
        entry.waiters.clear();
    }

    /**
     * Expires unanswered requests, withdraws abandoned ones, and forgets settled ones past their retention.
     */
    sweep(): void {
        const now = this.now();
        let isChanged = false;
        for (const [id, entry] of this.entries) {
            if (entry.request.status === 'pending') {
                if (now >= entry.request.expiresAt) {
                    this.settle(entry, 'expired');
                    isChanged = true;
                } else if (
                    entry.waiters.size === 0 &&
                    now - entry.lastPolledAt >= SECRET_REQUEST_ABANDON_MS
                ) {
                    this.settle(entry, 'cancelled');
                    isChanged = true;
                }
            } else if (now - (entry.settledAt ?? now) >= SETTLED_RETENTION_MS) {
                this.entries.delete(id);
            }
        }
        if (isChanged) this.onChange();
    }

    pending(): AgentSecretRequest[] {
        return this.entries
            .values()
            .filter((entry) => entry.request.status === 'pending')
            .map((entry) => entry.request)
            .toArray();
    }

    get(requestId: string): AgentSecretRequest | undefined {
        return this.entries.get(requestId)?.request;
    }

    offer(offer: AgentSecretRequestOffer): AgentSecretRequest {
        const now = this.now();
        for (const entry of this.entries.values()) {
            const { request } = entry;
            if (
                request.status === 'pending' &&
                request.terminalId === offer.terminalId &&
                request.name === offer.name
            ) {
                entry.lastPolledAt = now;
                return request;
            }
        }
        if (this.pending().length >= MAX_PENDING_REQUESTS)
            throw new CaxriError('CAPACITY', 'Too many secret requests are waiting for the user');
        const request: AgentSecretRequest = {
            id: randomUUID(),
            ...offer,
            status: 'pending',
            createdAt: now,
            expiresAt: now + SECRET_REQUEST_LIFETIME_MS,
        };
        this.entries.set(request.id, { request, lastPolledAt: now, waiters: new Set() });
        this.onChange();
        return request;
    }

    /**
     * Waits up to `timeoutMs` for the request to settle and returns its status, `pending` on timeout. Only the Terminal
     * that raised a request can wait on it.
     */
    async wait(
        terminalId: string,
        requestId: string,
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<AgentSecretRequestStatus> {
        const entry = this.entries.get(requestId);
        if (entry?.request.terminalId !== terminalId)
            throw new CaxriError('NOT_FOUND', 'Secret request not found');
        entry.lastPolledAt = this.now();
        // An already aborted signal never fires `abort`, so the caller that disconnected first must not wait out the timer.
        if (entry.request.status !== 'pending' || signal?.aborted) return entry.request.status;
        const { promise, resolve } = Promise.withResolvers<AgentSecretRequestStatus>();
        const waiter = (status: SettledStatus) => resolve(status);
        const finish = () => {
            entry.waiters.delete(waiter);
            entry.lastPolledAt = this.now();
            resolve(entry.request.status);
        };
        const timer = setTimeout(finish, timeoutMs);
        signal?.addEventListener('abort', finish, { once: true });
        entry.waiters.add(waiter);
        try {
            return await promise;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
        }
    }

    /**
     * Settles one pending request with the user's decision.
     */
    answer(requestId: string, status: 'saved' | 'declined'): AgentSecretRequest {
        const entry = this.entries.get(requestId);
        if (!entry) throw new CaxriError('NOT_FOUND', 'Secret request not found');
        if (entry.request.status !== 'pending')
            throw new CaxriError('CONFLICT', 'This secret request is no longer waiting');
        this.settle(entry, status);
        this.onChange();
        return entry.request;
    }

    /**
     * Marks every pending request a newly saved secret now covers as `saved`, so saving from Settings answers a card
     * that asked for the same name.
     */
    satisfy(name: string, isCovered: (projectId: string) => boolean): string[] {
        const satisfied: string[] = [];
        for (const entry of this.entries.values()) {
            if (!(
                entry.request.status === 'pending' &&
                entry.request.name === name &&
                isCovered(entry.request.projectId)
            )) {
                continue;
            }

            this.settle(entry, 'saved');
            satisfied.push(entry.request.id);
        }
        if (satisfied.length > 0) this.onChange();
        return satisfied;
    }

    close(): void {
        clearInterval(this.sweepTimer);
        for (const entry of this.entries.values()) this.settle(entry, 'cancelled');
    }
}
