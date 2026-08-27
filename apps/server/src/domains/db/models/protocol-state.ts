import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import type {
    DurableEventStorePage,
    DurableServerEvent,
    NewProtocolCommandReceipt,
    ProtocolEventEnvelope,
    StoredProtocolCommandReceipt,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    commandReplyEnvelopeSchema,
    durableServerEventSchema,
    durableServerIdentitySchema,
    isCaxriMethod,
    isSnapshotOnlyDurableEventName,
    protocolClientIdentitySchema,
    protocolEventEnvelopeSchema,
    serverStateEpochSchema,
} from '@caxri/protocol';
import { and, asc, count, eq, gt, inArray, max, min } from 'drizzle-orm';

import type {
    DurableProtocolIdentity,
    ProtocolRecoveryInspection,
    ProtocolRecoveryState,
} from '../../protocol-recovery';
import type { CaxriDrizzleDatabase } from '../connection';
import { protocolChangefeed, protocolCommandReceipts, protocolIdentity } from '../schema';

const IDENTITY_SINGLETON = 1;
export const MAX_PROTOCOL_COMMAND_RECEIPTS = 1_024;
export const MAX_PROTOCOL_CHANGEFEED_EVENTS = 256;
const MAX_PROTOCOL_RECEIPT_BYTES = 512 * 1024;
const MAX_PROTOCOL_CHANGEFEED_EVENT_BYTES = 256 * 1024;

function opaqueIdentity(): string {
    return randomBytes(16).toString('hex');
}

function assertBoundedJson(value: unknown, maximumBytes: number, label: string): string {
    const source = JSON.stringify(value);
    if (Buffer.byteLength(source, 'utf8') > maximumBytes)
        throw new CaxriError('CAPACITY', `${label} exceeds its durable storage budget`);
    return source;
}

function parseJson(source: string, label: string): unknown {
    try {
        return JSON.parse(source) as unknown;
    } catch {
        throw new CaxriError('INTERNAL', `Stored ${label} is invalid`);
    }
}

/**
 * Owns bounded protocol recovery state. The method table decides which command results are content-safe before calling
 * this model; this boundary validates wire shape, byte budgets, stable identities, and retention again before writing.
 */
export class ProtocolStateModel implements ProtocolRecoveryState {
    constructor(
        private readonly database: CaxriDrizzleDatabase,
        private readonly runTransaction: <T>(work: () => T) => T,
    ) {}

    private pruneReceipts(): void {
        const overflow =
            this.database.select({ value: count() }).from(protocolCommandReceipts).get()!.value -
            MAX_PROTOCOL_COMMAND_RECEIPTS;
        if (overflow <= 0) return;
        const rows = this.database
            .select({
                stateEpoch: protocolCommandReceipts.stateEpoch,
                clientId: protocolCommandReceipts.clientId,
                requestId: protocolCommandReceipts.requestId,
            })
            .from(protocolCommandReceipts)
            .orderBy(
                asc(protocolCommandReceipts.createdAt),
                asc(protocolCommandReceipts.clientId),
                asc(protocolCommandReceipts.requestId),
            )
            .limit(overflow)
            .all();
        for (const row of rows)
            this.database
                .delete(protocolCommandReceipts)
                .where(
                    and(
                        eq(protocolCommandReceipts.stateEpoch, row.stateEpoch),
                        eq(protocolCommandReceipts.clientId, row.clientId),
                        eq(protocolCommandReceipts.requestId, row.requestId),
                    ),
                )
                .run();
    }

    private pruneChangefeed(stateEpoch: string): void {
        const overflow =
            this.database
                .select({ value: count() })
                .from(protocolChangefeed)
                .where(eq(protocolChangefeed.stateEpoch, stateEpoch))
                .get()!.value - MAX_PROTOCOL_CHANGEFEED_EVENTS;
        if (overflow <= 0) return;
        const sequences = this.database
            .select({ sequence: protocolChangefeed.sequence })
            .from(protocolChangefeed)
            .where(eq(protocolChangefeed.stateEpoch, stateEpoch))
            .orderBy(asc(protocolChangefeed.sequence))
            .limit(overflow)
            .all();
        this.database
            .delete(protocolChangefeed)
            .where(
                inArray(
                    protocolChangefeed.sequence,
                    sequences.map(({ sequence }) => sequence),
                ),
            )
            .run();
    }

    identity(now = Date.now()): DurableProtocolIdentity {
        const current = this.database
            .select()
            .from(protocolIdentity)
            .where(eq(protocolIdentity.singleton, IDENTITY_SINGLETON))
            .get();
        if (current)
            return {
                serverId: durableServerIdentitySchema.parse(current.serverId),
                stateEpoch: serverStateEpochSchema.parse(current.stateEpoch),
            };
        const identity = {
            serverId: opaqueIdentity(),
            stateEpoch: opaqueIdentity(),
        };
        this.database
            .insert(protocolIdentity)
            .values({ singleton: IDENTITY_SINGLETON, ...identity, createdAt: now })
            .run();
        return identity;
    }

    getReceipt(
        stateEpoch: string,
        clientId: string,
        requestId: string,
    ): StoredProtocolCommandReceipt | undefined {
        serverStateEpochSchema.parse(stateEpoch);
        protocolClientIdentitySchema.parse(clientId);
        const row = this.database
            .select()
            .from(protocolCommandReceipts)
            .where(
                and(
                    eq(protocolCommandReceipts.stateEpoch, stateEpoch),
                    eq(protocolCommandReceipts.clientId, clientId),
                    eq(protocolCommandReceipts.requestId, requestId),
                ),
            )
            .get();
        if (!row) return;
        if (!isCaxriMethod(row.method))
            throw new CaxriError('INTERNAL', 'Stored protocol command method is invalid');
        return {
            ...row,
            method: row.method,
            reply: commandReplyEnvelopeSchema.parse(parseJson(row.replyJson, 'command receipt')),
        };
    }

    saveReceipt(input: NewProtocolCommandReceipt): StoredProtocolCommandReceipt {
        serverStateEpochSchema.parse(input.stateEpoch);
        protocolClientIdentitySchema.parse(input.clientId);
        if (!/^[0-9a-f]{64}$/u.test(input.requestFingerprint))
            throw new CaxriError('VALIDATION', 'Command receipt fingerprint is invalid');
        const reply = commandReplyEnvelopeSchema.parse(input.reply);
        if (!reply.ok)
            throw new CaxriError(
                'VALIDATION',
                'Failed commands do not create durable effect receipts',
            );
        const replyJson = assertBoundedJson(reply, MAX_PROTOCOL_RECEIPT_BYTES, 'Command receipt');
        return this.transaction(() => {
            this.database
                .insert(protocolCommandReceipts)
                .values({ ...input, replyJson })
                .onConflictDoNothing()
                .run();
            const stored = this.getReceipt(input.stateEpoch, input.clientId, input.requestId)!;
            if (
                stored.method !== input.method ||
                stored.requestFingerprint !== input.requestFingerprint
            )
                throw new CaxriError(
                    'VALIDATION',
                    'A request ID cannot be reused for different command input',
                );
            this.pruneReceipts();
            return stored;
        });
    }

    appendEvent(
        stateEpoch: string,
        event: DurableServerEvent,
        createdAt = Date.now(),
    ): ProtocolEventEnvelope {
        serverStateEpochSchema.parse(stateEpoch);
        const parsedEvent = durableServerEventSchema.parse(event);
        const eventJson = assertBoundedJson(
            isSnapshotOnlyDurableEventName(parsedEvent.event)
                ? { recovery: 'snapshot-required' }
                : parsedEvent,
            MAX_PROTOCOL_CHANGEFEED_EVENT_BYTES,
            'Changefeed event',
        );
        return this.transaction(() => {
            const inserted = this.database
                .insert(protocolChangefeed)
                .values({
                    stateEpoch,
                    eventName: parsedEvent.event,
                    eventJson,
                    createdAt,
                })
                .returning({ sequence: protocolChangefeed.sequence })
                .get();
            this.pruneChangefeed(stateEpoch);
            return protocolEventEnvelopeSchema.parse({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                cursor: inserted.sequence,
                event: parsedEvent,
            });
        });
    }

    eventsAfter(stateEpoch: string, afterSequence: number): DurableEventStorePage {
        serverStateEpochSchema.parse(stateEpoch);
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
            throw new CaxriError('VALIDATION', 'Event cursor is invalid');
        const rows = this.database
            .select()
            .from(protocolChangefeed)
            .where(
                and(
                    eq(protocolChangefeed.stateEpoch, stateEpoch),
                    gt(protocolChangefeed.sequence, afterSequence),
                ),
            )
            .orderBy(asc(protocolChangefeed.sequence))
            .limit(MAX_PROTOCOL_CHANGEFEED_EVENTS)
            .all();
        const requiresSnapshot = rows.some((row) => isSnapshotOnlyDurableEventName(row.eventName));
        return {
            events: requiresSnapshot
                ? []
                : rows.map((row) =>
                      protocolEventEnvelopeSchema.parse({
                          protocolVersion: CAXRI_PROTOCOL_VERSION,
                          cursor: row.sequence,
                          event: parseJson(row.eventJson, 'changefeed event'),
                      }),
                  ),
            requiresSnapshot,
        };
    }

    changefeedBounds(stateEpoch: string): { count: number; earliest: number; latest: number } {
        serverStateEpochSchema.parse(stateEpoch);
        const bounds = this.database
            .select({
                count: count(),
                earliest: min(protocolChangefeed.sequence),
                latest: max(protocolChangefeed.sequence),
            })
            .from(protocolChangefeed)
            .where(eq(protocolChangefeed.stateEpoch, stateEpoch))
            .get()!;
        return {
            count: bounds.count,
            earliest: bounds.earliest ?? 0,
            latest: bounds.latest ?? 0,
        };
    }

    inspect(): ProtocolRecoveryInspection {
        const identity = this.identity();
        const bounds = this.changefeedBounds(identity.stateEpoch);
        return {
            changefeedEntries: this.database
                .select({ value: count() })
                .from(protocolChangefeed)
                .get()!.value,
            commandReceipts: this.database
                .select({ value: count() })
                .from(protocolCommandReceipts)
                .get()!.value,
            earliestCursor: bounds.earliest,
            latestCursor: bounds.latest,
            serverIdSuffix: identity.serverId.slice(-8),
            stateEpochSuffix: identity.stateEpoch.slice(-8),
        };
    }

    transaction<T>(work: () => T): T {
        return this.runTransaction(work);
    }
}
