import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type {
    BinaryStreamCloseReason,
    BinaryStreamOperation,
    BinaryStreamTicketGrant,
    CommandExecutionContext,
    LocalClientStreamTicketRequest,
    LocalServerStreamTicketReply,
    ProtocolFeature,
} from '@caxri/protocol';
import {
    BINARY_STREAM_MAX_PENDING_TICKETS,
    BINARY_STREAM_PATH,
    BINARY_STREAM_TICKET_TTL_MS,
    binaryStreamCloseCodes,
    binaryStreamTicketSchema,
    CaxriError,
    localClientStreamTicketRequestSchema,
    localServerStreamTicketReplySchema,
    toWireError,
} from '@caxri/protocol';
import type WebSocket from 'ws';

export interface BinaryStreamOwner {
    context: CommandExecutionContext;
    connectionId: string;
}

export interface BinaryStreamClaim extends BinaryStreamOwner {
    operation: BinaryStreamOperation;
}

interface PendingTicket extends BinaryStreamClaim {
    expiresAt: number;
    ticket: string;
}

interface RevokedConnection {
    expiresAt: number;
    reason: BinaryStreamCloseReason;
}

export class BinaryStreamTicketError extends CaxriError {
    constructor(readonly reason: BinaryStreamCloseReason) {
        const code =
            reason === 'capacity-exceeded'
                ? 'CAPACITY'
                : reason === 'server-unavailable'
                  ? 'UNAVAILABLE'
                  : reason === 'unauthorized' || reason === 'scope-mismatch'
                    ? 'FORBIDDEN'
                    : 'CONFLICT';
        super(code, `Binary stream ticket rejected: ${reason}`);
    }
}

interface BinaryStreamTicketAuthorityOptions {
    createTicket?: () => string;
    maximumTickets?: number;
    now?: () => number;
    ticketTtlMs?: number;
}

/**
 * Issues opaque, one-use attachment identities. Only authoritative Server-side scope is retained with a ticket; the
 * bearer value discloses no Session, Terminal, path, principal, or long-lived credential.
 */
export class BinaryStreamTicketAuthority {
    private readonly createTicket: () => string;
    private readonly maximumTickets: number;
    private readonly now: () => number;
    private readonly revokedConnections = new Map<string, RevokedConnection>();
    private readonly tickets = new Map<string, PendingTicket>();
    private readonly ticketTtlMs: number;

    constructor(options: BinaryStreamTicketAuthorityOptions = {}) {
        this.createTicket = options.createTicket ?? (() => randomBytes(32).toString('hex'));
        this.maximumTickets = options.maximumTickets ?? BINARY_STREAM_MAX_PENDING_TICKETS;
        this.now = options.now ?? Date.now;
        this.ticketTtlMs = options.ticketTtlMs ?? BINARY_STREAM_TICKET_TTL_MS;
        if (
            !Number.isSafeInteger(this.maximumTickets) ||
            this.maximumTickets < 1 ||
            this.maximumTickets > BINARY_STREAM_MAX_PENDING_TICKETS
        )
            throw new CaxriError('VALIDATION', 'Binary stream ticket capacity is invalid');
    }

    private prune(now = this.now()): void {
        for (const [ticket, pending] of this.tickets)
            if (pending.expiresAt <= now) this.tickets.delete(ticket);
        for (const [connectionId, revoked] of this.revokedConnections)
            if (revoked.expiresAt <= now) this.revokedConnections.delete(connectionId);
    }

    issue(owner: BinaryStreamOwner, operation: BinaryStreamOperation): BinaryStreamTicketGrant {
        this.prune();
        const revoked = this.revokedConnections.get(owner.connectionId);
        if (revoked) throw new BinaryStreamTicketError(revoked.reason);
        if (this.tickets.size >= this.maximumTickets)
            throw new BinaryStreamTicketError('capacity-exceeded');
        let ticket: string | undefined;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const candidate = binaryStreamTicketSchema.parse(this.createTicket());
            if (!this.tickets.has(candidate)) {
                ticket = candidate;
                break;
            }
        }
        if (!ticket) throw new CaxriError('INTERNAL', 'Binary stream ticket entropy collided');
        const expiresAt = this.now() + this.ticketTtlMs;
        this.tickets.set(ticket, { ...owner, operation, expiresAt, ticket });
        return { ticket, path: BINARY_STREAM_PATH, expiresAt };
    }

    redeem(ticket: string): BinaryStreamClaim {
        const parsed = binaryStreamTicketSchema.safeParse(ticket);
        if (!parsed.success) throw new BinaryStreamTicketError('unauthorized');
        const pending = this.tickets.get(parsed.data);
        if (!pending) throw new BinaryStreamTicketError('unauthorized');
        this.tickets.delete(parsed.data);
        const revoked = this.revokedConnections.get(pending.connectionId);
        if (revoked) throw new BinaryStreamTicketError(revoked.reason);
        if (pending.expiresAt <= this.now()) throw new BinaryStreamTicketError('ticket-expired');
        const { context, connectionId, operation } = pending;
        return { context, connectionId, operation };
    }

    revokeConnection(connectionId: string, reason: BinaryStreamCloseReason): void {
        this.prune();
        if (!this.revokedConnections.has(connectionId))
            this.revokedConnections.set(connectionId, {
                expiresAt: this.now() + this.ticketTtlMs,
                reason,
            });
        while (this.revokedConnections.size > BINARY_STREAM_MAX_PENDING_TICKETS)
            this.revokedConnections.delete(this.revokedConnections.keys().next().value!);
    }

    clear(): void {
        this.tickets.clear();
        this.revokedConnections.clear();
    }
}

interface TicketRequestState {
    commands: readonly string[];
    context: CommandExecutionContext;
    features: readonly ProtocolFeature[];
}

export interface BinaryStreamControlOptions {
    handleClaim?(socket: WebSocket, claim: BinaryStreamClaim): void;
    ticketAuthority?: BinaryStreamTicketAuthority;
}

function authorizationTicket(request: IncomingMessage): string | undefined {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return;
    const ticket = authorization.slice('Bearer '.length);
    return binaryStreamTicketSchema.safeParse(ticket).success ? ticket : undefined;
}

/**
 * Bridges small authenticated ticket messages on control to separately backpressured binary WebSocket connections.
 */
export class BinaryStreamControl {
    private readonly authority: BinaryStreamTicketAuthority;
    private readonly sockets = new Set<WebSocket>();

    constructor(private readonly options: BinaryStreamControlOptions = {}) {
        this.authority = options.ticketAuthority ?? new BinaryStreamTicketAuthority();
    }

    issue(state: TicketRequestState, raw: unknown): LocalServerStreamTicketReply | undefined {
        const parsed = localClientStreamTicketRequestSchema.safeParse(raw);
        if (!parsed.success) return;
        const request: LocalClientStreamTicketRequest = parsed.data;
        try {
            if (!state.features.includes('binary-streams-v1'))
                throw new CaxriError('CONFLICT', 'Binary streams were not negotiated');
            if (!state.commands.includes(request.operation.method))
                throw new CaxriError(
                    'FORBIDDEN',
                    `Missing capability for ${request.operation.method}`,
                );
            const connectionId = state.context.connection?.connectionId;
            if (!connectionId)
                throw new CaxriError('CONFLICT', 'Binary streams require a connection identity');
            const grant = this.authority.issue(
                { context: state.context, connectionId },
                request.operation,
            );
            return localServerStreamTicketReplySchema.parse({
                type: 'stream-ticket.reply',
                id: request.id,
                ok: true,
                grant,
            });
        } catch (error) {
            return localServerStreamTicketReplySchema.parse({
                type: 'stream-ticket.reply',
                id: request.id,
                ok: false,
                error: toWireError(error),
            });
        }
    }

    accept(socket: WebSocket, request: IncomingMessage): void {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
        socket.on('error', () => {});
        try {
            const ticket = authorizationTicket(request);
            if (!ticket) throw new BinaryStreamTicketError('unauthorized');
            if (!this.options.handleClaim) throw new BinaryStreamTicketError('server-unavailable');
            const claim = this.authority.redeem(ticket);
            this.options.handleClaim(socket, claim);
        } catch (error) {
            const reason =
                error instanceof BinaryStreamTicketError ? error.reason : 'server-unavailable';
            socket.close(binaryStreamCloseCodes[reason], reason);
        }
    }

    revokeConnection(connectionId: string, reason: BinaryStreamCloseReason): void {
        this.authority.revokeConnection(connectionId, reason);
    }

    close(): void {
        this.authority.clear();
        for (const socket of this.sockets) socket.terminate();
        this.sockets.clear();
    }
}
