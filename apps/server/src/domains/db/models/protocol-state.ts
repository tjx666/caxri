import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import type { DurableServerEvent, ProtocolEventEnvelope } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    commandReplyEnvelopeSchema,
    durableServerEventSchema,
    durableServerIdentitySchema,
    isCaxriMethod,
    protocolClientIdentitySchema,
    protocolEventEnvelopeSchema,
    serverStateEpochSchema,
} from '@caxri/protocol';
import { and, asc, count, eq, gt, inArray } from 'drizzle-orm';

import type {
    DurableProtocolIdentity,
    NewProtocolCommandReceipt,
    ProtocolRecoveryState,
    StoredProtocolCommandReceipt,
} from '../../protocol-recovery';
import type { CaxriDrizzleDatabase } from '../connection';
import { protocolChangefeed, protocolCommandReceipts, protocolIdentity } from '../schema';

const IDENTITY_SINGLETON = 1;
export const MAX_PROTOCOL_COMMAND_RECEIPTS = 1_024;
export const MAX_PROTOCOL_CHANGEFEED_EVENTS = 256;
export const MAX_PROTOCOL_RECEIPT_BYTES = 512 * 1024;
export const MAX_PROTOCOL_CHANGEFEED_EVENT_BYTES = 256 * 1024;

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
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    private pruneReceipts(): void {
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
            .all();
        const overflow = rows.length - MAX_PROTOCOL_COMMAND_RECEIPTS;
        const rowsToRemove = rows.slice(0, Math.max(0, overflow));
        for (const row of rowsToRemove)
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
        const sequences = this.database
            .select({ sequence: protocolChangefeed.sequence })
            .from(protocolChangefeed)
            .where(eq(protocolChangefeed.stateEpoch, stateEpoch))
            .orderBy(asc(protocolChangefeed.sequence))
            .all();
        const removable = sequences
            .slice(0, Math.max(0, sequences.length - MAX_PROTOCOL_CHANGEFEED_EVENTS))
            .map(({ sequence }) => sequence);
        if (removable.length > 0)
            this.database
                .delete(protocolChangefeed)
                .where(inArray(protocolChangefeed.sequence, removable))
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
    }

    appendEvent(
        stateEpoch: string,
        event: DurableServerEvent,
        createdAt = Date.now(),
    ): ProtocolEventEnvelope {
        serverStateEpochSchema.parse(stateEpoch);
        const parsedEvent = durableServerEventSchema.parse(event);
        const eventJson = assertBoundedJson(
            parsedEvent,
            MAX_PROTOCOL_CHANGEFEED_EVENT_BYTES,
            'Changefeed event',
        );
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
    }

    eventsAfter(stateEpoch: string, afterSequence: number): ProtocolEventEnvelope[] {
        serverStateEpochSchema.parse(stateEpoch);
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
            throw new CaxriError('VALIDATION', 'Event cursor is invalid');
        return this.database
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
            .all()
            .map((row) =>
                protocolEventEnvelopeSchema.parse({
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    cursor: row.sequence,
                    event: parseJson(row.eventJson, 'changefeed event'),
                }),
            );
    }

    changefeedBounds(stateEpoch: string): { count: number; earliest: number; latest: number } {
        serverStateEpochSchema.parse(stateEpoch);
        const rows = this.database
            .select({ sequence: protocolChangefeed.sequence })
            .from(protocolChangefeed)
            .where(eq(protocolChangefeed.stateEpoch, stateEpoch))
            .orderBy(asc(protocolChangefeed.sequence))
            .all();
        return {
            count: rows.length,
            earliest: rows.at(0)?.sequence ?? 0,
            latest: rows.at(-1)?.sequence ?? 0,
        };
    }

    inspect(): { changefeedEntries: number; commandReceipts: number } {
        return {
            changefeedEntries: this.database
                .select({ value: count() })
                .from(protocolChangefeed)
                .get()!.value,
            commandReceipts: this.database
                .select({ value: count() })
                .from(protocolCommandReceipts)
                .get()!.value,
        };
    }
}
