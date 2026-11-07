import type { AgentDelegationReceipt, Principal } from '@caxri/protocol';
import {
    agentDelegationAnswerSchema,
    agentDelegationCreateSchema,
    agentDelegationReceiptSchema,
    agentLaunchSettingsSchema,
    CaxriError,
    delegationProviderSchema,
    delegationRedirectStateSchema,
    delegationRetryModeSchema,
    MAX_DELEGATION_REDIRECT_OPERATIONS,
    principalSchema,
} from '@caxri/protocol';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { CaxriDrizzleDatabase } from '../connection';
import { agentDelegations } from '../schema';
import { DelegationHandBacksModel } from './delegation-handbacks';
import { DelegationHistoryModel } from './delegation-history';
import { DelegationNoticeDeliveriesModel } from './delegation-notice-deliveries';
import { DelegationNoticesModel } from './delegation-notices';
import { DelegationQuestionsModel } from './delegation-questions';

const activeStatuses = [
    'requested',
    'launching',
    'awaiting_ready',
    'submitting',
    'running',
    'collecting',
    'blocked',
];

/**
 * Whether a task in `status` is still in flight: not yet settled as completed, failed, or stopped.
 */
export function isActiveDelegationStatus(status: string): boolean {
    return activeStatuses.includes(status);
}

/**
 * The pairing rules of a scheduled retry, enforced on every save so no writer can store a half state. A pending
 * schedule is a held claim: it needs the reserved successor (`retriedAs`) and the mode it will run in. A refused or
 * missed schedule released its claim, so its outcome never stands beside a claim, pending or started.
 */
function isRetryScheduleConsistent(record: {
    receipt: Pick<
        AgentDelegationReceipt,
        'retriedAs' | 'retryScheduledFor' | 'retryScheduleOutcome'
    >;
    retryMode?: string;
    retryProvider?: string;
}): boolean {
    const { retriedAs, retryScheduledFor, retryScheduleOutcome } = record.receipt;
    if (retryScheduledFor !== undefined && (!retriedAs || !record.retryMode)) return false;
    // A switched Agent belongs only to an immediate fresh claim.
    if (
        record.retryProvider !== undefined &&
        (retryScheduledFor !== undefined || !retriedAs || record.retryMode !== 'fresh')
    )
        return false;
    return retryScheduleOutcome === undefined || retriedAs === undefined;
}

const redirectClaimSchema = z.strictObject({
    operationId: z.string().min(1).max(64),
    digest: z.string().regex(/^[\da-f]{64}$/u),
    state: delegationRedirectStateSchema,
    at: z.number().int().positive(),
});

const storedDelegationSchema = z
    .strictObject({
        receipt: agentDelegationReceiptSchema,
        principal: principalSchema,
        input: agentDelegationCreateSchema,
        fingerprint: z.string(),
        promptDigest: z.string(),
        frozenLaunch: agentLaunchSettingsSchema,
        frozenInstructions: z.string().max(8192).optional(),
        launchId: z.string().optional(),
        providerSessionId: z.string().optional(),
        turnId: z.string().optional(),
        responseDigest: z.string().optional(),
        responseByteLength: z.number().int().nonnegative().optional(),
        responseStopCount: z.number().int().nonnegative().optional(),
        responseOverflow: z.boolean().optional(),
        transcriptOffset: z.number().int().nonnegative().optional(),
        answer: agentDelegationAnswerSchema.optional(),
        /**
         * When a caller first read the answer through wait or result; makes the record evictable under capacity
         * pressure.
         */
        collectedAt: z.number().int().nonnegative().optional(),
        rootDelegationId: z.string().optional(),
        nextDelegationId: z.string().optional(),
        /**
         * The mode a retry claim (`receipt.retriedAs`) was made in, kept with the claim so a second request in the same
         * mode shares it and the other mode is refused. Set and cleared together with `retriedAs`.
         */
        retryMode: delegationRetryModeSchema.optional(),
        /**
         * The Agent a switched retry claim (`receipt.retriedAs`) runs on, set only for a fresh retry to a provider
         * other than the failed task's own. Absent means the failed task's provider. Set and cleared together with
         * `retriedAs`.
         */
        retryProvider: delegationProviderSchema.optional(),
        inputEpoch: z.number().int().nonnegative().optional(),
        hasHumanIntervention: z.boolean().optional(),
        /**
         * When a human first acted in the child Session (input, Stop, or Rewind), in epoch milliseconds, set where
         * `hasHumanIntervention` is. Set once, so a completed task's takeover is still dated.
         */
        humanInterventionAt: z.number().int().positive().optional(),
        /**
         * The turn of the caller's Agent Chat that was running when this task was created, so the caller's timeline can
         * place the delegation in the turn that made it. Absent for a caller that is not a Chat. Context only: an ID,
         * never text.
         */
        callerTurnId: z.string().min(1).max(256).optional(),
        /**
         * The launch of the caller's Agent that created this task (and, for a retry, of the failed task it retries). A
         * question the task's Agent asks counts the delegating Agent as gone once this launch retires, because a
         * resumed Agent is a new launch without authority over the task. Absent for a caller with no Agent launch. An
         * ID only.
         */
        callerLaunchId: z.string().min(1).max(256).optional(),
        /**
         * The provider conversation the caller's Agent Terminal held when this task was created (and, for a retry, of
         * the failed task it retries). A later generation of that Terminal that resumed this conversation still owns
         * the task; see `isDelegationOwner`. Absent for a caller with no Agent conversation. An ID only.
         */
        callerConversationId: z.string().min(1).max(256).optional(),
        hasLostTarget: z.boolean().optional(),
        /**
         * The redirects (`agent.delegation.redirect`) this task has been asked to deliver, one claim per operation ID.
         * A claim is written before the message is sent and settled after, so a repeated request is answered from it
         * and a message whose delivery is in doubt (`pending` or `unknown`) is never sent a second time. Holds a digest
         * of the text, never the text. At most `MAX_DELEGATION_REDIRECT_OPERATIONS`; never evicted.
         */
        redirects: z.array(redirectClaimSchema).max(MAX_DELEGATION_REDIRECT_OPERATIONS).optional(),
        continuationPromptDigests: z
            .array(z.string().regex(/^[\da-f]{64}$/u))
            .max(64)
            .optional(),
    })
    .refine(isRetryScheduleConsistent, {
        message: 'A scheduled retry needs its claim, and a retry outcome excludes one',
    });

export type StoredAgentDelegation = z.infer<typeof storedDelegationSchema>;

/**
 * Most saved task records admission keeps.
 */
const MAX_SAVED_DELEGATIONS = 1024;

function allRecords(database: CaxriDrizzleDatabase): StoredAgentDelegation[] {
    return database
        .select()
        .from(agentDelegations)
        .all()
        .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)));
}

/**
 * Deletes the oldest records of tasks that settled with no answer to collect (failed, interrupted, or stopped) or whose
 * answer a caller already claimed (`collectedAt`), until one slot is free, and returns the task directory names no
 * remaining record uses. A completed task with an unread answer is kept. A record another one still points at (a
 * chain's next task, or a root whose directory its children share) is kept so those links never dangle. Synchronous, so
 * the insert that follows happens in the same tick.
 */
function pruneForAdmission(
    database: CaxriDrizzleDatabase,
    admitted: StoredAgentDelegation,
): string[] {
    const all = allRecords(database);
    const overflow = all.length - MAX_SAVED_DELEGATIONS + 1;
    if (overflow <= 0) return [];
    // The admitted task is not stored yet, so its links are not in `all`: a follow-up or resume shares its
    // predecessor's root directory and links the predecessor only after this insert.
    const { followUpOf, resumeFrom } = admitted.input;
    const referenced = new Set<string>(
        [admitted.rootDelegationId, followUpOf, resumeFrom].filter((value) => value !== undefined),
    );
    if (admitted.receipt.retryOf) referenced.add(admitted.receipt.retryOf);
    for (const { receipt, rootDelegationId, nextDelegationId } of all) {
        if (nextDelegationId) referenced.add(nextDelegationId);
        if (rootDelegationId && rootDelegationId !== receipt.delegationId)
            referenced.add(rootDelegationId);
        /**
         * A retry chain is protected one way at a time, so chains cannot hold slots forever (a permanent mutual
         * reference would). A failed task keeps its successor for as long as the failed task exists; the successor
         * keeps the failed task only while it is unsettled. Once it settled, the failed task is releasable and the
         * chain drains oldest first. A claim whose successor is not stored yet names nothing to protect.
         */
        if (receipt.retriedAs) referenced.add(receipt.retriedAs);
        // The failed task itself carries a pending schedule: pruning it would drop the retry silently.
        if (receipt.retryScheduledFor !== undefined) referenced.add(receipt.delegationId);
        if (receipt.retryOf && isActiveDelegationStatus(receipt.status))
            referenced.add(receipt.retryOf);
    }
    const removable = all
        .filter(
            ({ receipt, answer, collectedAt }) =>
                !isActiveDelegationStatus(receipt.status) &&
                (!answer || collectedAt !== undefined) &&
                !referenced.has(receipt.delegationId),
        )
        .toSorted(
            (a, b) =>
                a.receipt.updatedAt - b.receipt.updatedAt ||
                a.receipt.delegationId.localeCompare(b.receipt.delegationId),
        )
        .slice(0, overflow);
    if (removable.length === 0) return [];
    database
        .delete(agentDelegations)
        .where(
            inArray(
                agentDelegations.id,
                removable.map(({ receipt }) => receipt.delegationId),
            ),
        )
        .run();
    return removable
        .filter(
            ({ receipt, rootDelegationId }) =>
                !rootDelegationId || rootDelegationId === receipt.delegationId,
        )
        .map(({ receipt }) => receipt.delegationId);
}

/**
 * Bounded private task storage. At capacity, admission first prunes the oldest settled tasks that hold nothing a caller
 * could still collect (no answer, or an answer already read), and refuses capacity rather than discarding unclaimed
 * answers or live tasks.
 */
export class AgentDelegationsModel {
    /**
     * Terminals whose tasks are known to all carry the takeover mark (`false`), so the per-keystroke takeover pass in
     * `interruptDelegationTerminal` skips SQLite. Absent means unknown. `insert` and `save` drop the entry of the
     * Terminal they write (a task may gain a mark or a Terminal only through them), and pruning only removes tasks,
     * which cannot create an unmarked one. Process-local, so a restart reseeds it from the table.
     */
    private readonly unmarkedTerminals = new Map<string, boolean>();

    /**
     * The questions delegated Agents ask. They belong to a task record: `ON DELETE CASCADE` removes them with it, so
     * pruning needs no extra step.
     */
    readonly questions: DelegationQuestionsModel;

    /**
     * Settled-task history and the provenance edges of delegated Sessions. Unlike the questions it has no foreign key
     * to a task record, so pruning a task or deleting its Session leaves it in place.
     */
    readonly history: DelegationHistoryModel;

    /**
     * The notices owed to the Agents that delegated tasks. Like the questions, they cascade from a task record.
     */
    readonly notices: DelegationNoticesModel;

    /**
     * The notice messages actually written into a Chat, by text digest, so the Chat recognizes them. Unlike the notices
     * it has no foreign key to a task record, so it survives pruning the task.
     */
    readonly noticeDeliveries: DelegationNoticeDeliveriesModel;

    /**
     * The single-use grants the user gives when handing a taken-over Session back. Like the notices, they cascade from
     * a task record.
     */
    readonly handBacks: DelegationHandBacksModel;

    constructor(private readonly database: CaxriDrizzleDatabase) {
        this.questions = new DelegationQuestionsModel(database);
        this.history = new DelegationHistoryModel(database);
        this.notices = new DelegationNoticesModel(database);
        this.noticeDeliveries = new DelegationNoticeDeliveriesModel(database);
        this.handBacks = new DelegationHandBacksModel(database);
    }

    private forgetUnmarked(record: StoredAgentDelegation): void {
        if (record.receipt.terminalId) this.unmarkedTerminals.delete(record.receipt.terminalId);
    }

    get(id: string): StoredAgentDelegation | undefined {
        const row = this.database
            .select()
            .from(agentDelegations)
            .where(eq(agentDelegations.id, id))
            .get();
        return row ? storedDelegationSchema.parse(JSON.parse(row.recordJson)) : undefined;
    }

    /**
     * Child task IDs name files inside their root task, never independently owned top-level directories.
     */
    storageRootsForSessions(sessionIds: readonly string[]): string[] {
        if (sessionIds.length === 0) return [];
        const rows = this.database
            .select({ recordJson: agentDelegations.recordJson })
            .from(agentDelegations)
            .where(inArray(agentDelegations.sessionId, [...sessionIds]))
            .all();
        return [
            ...new Set(
                rows.map((row) => {
                    const record = storedDelegationSchema.parse(JSON.parse(row.recordJson));
                    return record.rootDelegationId ?? record.receipt.delegationId;
                }),
            ),
        ];
    }

    /**
     * Receipts only: callers that summarize tasks never need their private prompt, launch, or answer.
     */
    receiptsForSessions(sessionIds: readonly string[]): AgentDelegationReceipt[] {
        if (sessionIds.length === 0) return [];
        return this.database
            .select({ recordJson: agentDelegations.recordJson })
            .from(agentDelegations)
            .where(inArray(agentDelegations.sessionId, [...sessionIds]))
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)).receipt);
    }

    /**
     * The principals that recorded a task in `sessionId`: the proof a delegation client created work there, which
     * disappears with a pruned record.
     */
    principalsForSession(sessionId: string): Principal[] {
        return this.database
            .select({ recordJson: agentDelegations.recordJson })
            .from(agentDelegations)
            .where(eq(agentDelegations.sessionId, sessionId))
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)).principal);
    }

    /**
     * When the user first took over each of the named Sessions: the earliest `humanInterventionAt` among its tasks. A
     * Session never taken over is absent.
     */
    takeoversForSessions(sessionIds: readonly string[]): Map<string, number> {
        return this.receiptsAndTakeoversForSessions(sessionIds).takeovers;
    }

    /**
     * The receipts and the takeovers (see {@link takeoversForSessions}) of the named Sessions from one read and one
     * parse of their records, for the feed that needs both. `takeoverTimes` lists every task's takeover per Session,
     * oldest first: after a hand-back the user can take the same Session over again, once per task.
     */
    receiptsAndTakeoversForSessions(sessionIds: readonly string[]): {
        receipts: AgentDelegationReceipt[];
        takeovers: Map<string, number>;
        takeoverTimes: Map<string, number[]>;
    } {
        const receipts: AgentDelegationReceipt[] = [];
        const takeovers = new Map<string, number>();
        const takeoverTimes = new Map<string, number[]>();
        if (sessionIds.length === 0) return { receipts, takeovers, takeoverTimes };
        const rows = this.database
            .select({ recordJson: agentDelegations.recordJson })
            .from(agentDelegations)
            .where(inArray(agentDelegations.sessionId, [...sessionIds]))
            .all();
        for (const row of rows) {
            const { receipt, humanInterventionAt } = storedDelegationSchema.parse(
                JSON.parse(row.recordJson),
            );
            receipts.push(receipt);
            if (humanInterventionAt === undefined) continue;
            const known = takeovers.get(receipt.sessionId);
            if (known === undefined || humanInterventionAt < known)
                takeovers.set(receipt.sessionId, humanInterventionAt);
            const times = takeoverTimes.get(receipt.sessionId) ?? [];
            times.push(humanInterventionAt);
            takeoverTimes.set(receipt.sessionId, times);
        }
        for (const times of takeoverTimes.values()) times.sort((a, b) => a - b);
        return { receipts, takeovers, takeoverTimes };
    }

    /**
     * The receipts of the named tasks, in no particular order; an unknown or pruned ID is absent.
     */
    receiptsByIds(ids: readonly string[]): AgentDelegationReceipt[] {
        if (ids.length === 0) return [];
        return this.database
            .select({ recordJson: agentDelegations.recordJson })
            .from(agentDelegations)
            .where(inArray(agentDelegations.id, [...ids]))
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)).receipt);
    }

    /**
     * The tasks a caller Terminal created during one of its Chat turns (`callerTurnId`). Reads the JSON blob in SQL, so
     * the lookup parses only matching rows.
     */
    forCallerTurn(callerTerminalId: string, turnId: string): StoredAgentDelegation[] {
        return this.database
            .select()
            .from(agentDelegations)
            .where(
                sql`json_extract(${agentDelegations.recordJson}, '$.receipt.callerTerminalId') = ${callerTerminalId} and json_extract(${agentDelegations.recordJson}, '$.callerTurnId') = ${turnId}`,
            )
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)));
    }

    /**
     * Every task that ran in one Session, in no particular order.
     */
    forSession(sessionId: string): StoredAgentDelegation[] {
        return this.database
            .select()
            .from(agentDelegations)
            .where(eq(agentDelegations.sessionId, sessionId))
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)));
    }

    /**
     * Whether any task of the Terminal still lacks the takeover mark. Answered from memory once known, so a caller on
     * the keystroke path costs no SQLite in steady state.
     */
    hasUnmarkedTask(terminalId: string): boolean {
        const known = this.unmarkedTerminals.get(terminalId);
        if (known !== undefined) return known;
        const hasUnmarked = this.forTerminal(terminalId).some((task) => !task.hasHumanIntervention);
        this.unmarkedTerminals.set(terminalId, hasUnmarked);
        return hasUnmarked;
    }

    forTerminal(terminalId: string): StoredAgentDelegation[] {
        return this.database
            .select()
            .from(agentDelegations)
            .where(eq(agentDelegations.terminalId, terminalId))
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)));
    }

    /**
     * @param record The task to admit.
     * @param onPruned Receives the task directory names of records pruned to make room, once their rows are gone, so
     *   the caller can remove the files they owned.
     */
    insert(
        record: StoredAgentDelegation,
        onPruned?: (directories: string[]) => void,
    ): StoredAgentDelegation {
        const pruned = pruneForAdmission(this.database, record);
        if (pruned.length > 0) onPruned?.(pruned);
        const count = this.database
            .select({ value: sql<number>`count(*)` })
            .from(agentDelegations)
            .get()!.value;
        if (count >= MAX_SAVED_DELEGATIONS)
            throw new CaxriError('CAPACITY', 'Too many saved Agent delegations');
        const parsed = storedDelegationSchema.parse(record);
        this.forgetUnmarked(parsed);
        this.database
            .insert(agentDelegations)
            .values({
                id: parsed.receipt.delegationId,
                sessionId: parsed.receipt.sessionId,
                recordJson: JSON.stringify(parsed),
            })
            .run();
        return parsed;
    }

    save(record: StoredAgentDelegation): StoredAgentDelegation {
        const parsed = storedDelegationSchema.parse(record);
        this.forgetUnmarked(parsed);
        const result = this.database
            .update(agentDelegations)
            .set({
                recordJson: JSON.stringify(parsed),
            })
            .where(eq(agentDelegations.id, parsed.receipt.delegationId))
            .run();
        if (result.changes !== 1)
            throw new CaxriError('NOT_FOUND', 'Agent delegation is unavailable');
        return parsed;
    }

    /**
     * Records that a caller read the task's answer, once. Deliberately leaves the receipt (revision and `updatedAt`)
     * alone: claiming is not a lifecycle transition, and `updatedAt` orders eviction.
     */
    markCollected(id: string, at: number): void {
        const record = this.get(id);
        if (record?.answer && record.collectedAt === undefined)
            this.save({ ...record, collectedAt: at });
    }

    /**
     * Every saved task, for a caller's own task list. Bounded by the insert capacity, so a full scan stays small.
     */
    all(): StoredAgentDelegation[] {
        return this.database
            .select()
            .from(agentDelegations)
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)));
    }

    /**
     * The failed tasks with a pending scheduled retry, oldest schedule first. Reads the JSON blob in SQL, so a poll
     * every few seconds parses only the rows that wait.
     */
    scheduledRetries(): StoredAgentDelegation[] {
        return this.database
            .select()
            .from(agentDelegations)
            .where(
                sql`json_extract(${agentDelegations.recordJson}, '$.receipt.retryScheduledFor') is not null`,
            )
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)))
            .toSorted((a, b) => a.receipt.retryScheduledFor! - b.receipt.retryScheduledFor!);
    }

    active(): StoredAgentDelegation[] {
        return this.database
            .select()
            .from(agentDelegations)
            .where(inArray(agentDelegations.status, activeStatuses))
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)));
    }
}
