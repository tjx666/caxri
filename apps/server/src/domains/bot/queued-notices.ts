import type { AgentDelegationReceipt } from '@caxri/protocol';

import { isActiveDelegationStatus } from '../db';
import type {
    BotHandoverNoticeEntry,
    BotInboxNoticeEntry,
    BotSessionNoticeEntry,
    BotSessionNoticeState,
} from './notice-text';

const SESSION_NOTICE_TIMING = { quietMs: 5000, maxWaitMs: 30_000 };
/**
 * How long a Session stays covered by its settled Caxri Bot delegation. The delegation notice already reports how the
 * task ended, and the Session's own activity change lands within moments of it, in either order.
 */
const SETTLED_DELEGATION_COVER_MS = 10_000;

type Queued<Entry> = Entry & { queuedAt: number };

/**
 * A snapshot of the in-memory notices one line or launch prompt reports.
 */
export interface QueuedNoticeBatch {
    inbox: Array<Queued<BotInboxNoticeEntry>>;
    handovers: Array<Queued<BotHandoverNoticeEntry>>;
    sessions: Array<Queued<BotSessionNoticeEntry>>;
}

interface BotQueuedNoticesOptions {
    now: () => number;
    /**
     * Called once pending Session changes settle, so the notifier can try to deliver them.
     */
    onSessionsSettled: () => void;
    /**
     * See `BotCompletionNotifierOptions.sessionNoticeTiming`.
     */
    sessionTiming?: { quietMs: number; maxWaitMs: number };
}

/**
 * Caxri Bot notices kept in memory only, unlike the persisted delegation notices: each source re-queues or re-reads its
 * own state after a restart. A later event for the same key replaces an earlier one.
 *
 * - Inbox events by item: the Inbox service re-queues unacknowledged replies, and Caxri Bot reads the item's current
 *   state with `bot inbox show`.
 * - Hand-over events by hand-over: the hand-over service re-queues every hand-over Caxri Bot has not continued.
 * - Managed-Session state changes by Session, batched rather than sent one by one: a change waits until no managed
 *   Session changed for a quiet period, bounded by a maximum wait after the first, and only each Session's latest state
 *   is kept. Settled changes stay queued while Caxri Bot is busy, collecting later ones into the one line its next idle
 *   point receives; until they settle they only ride along with another notice.
 */
export class BotQueuedNotices {
    private readonly inbox = new Map<string, Queued<BotInboxNoticeEntry>>();
    private readonly handovers = new Map<string, Queued<BotHandoverNoticeEntry>>();
    /**
     * A later change replaces an earlier one but keeps its queue time, so a Session that keeps changing still goes out
     * within the maximum wait.
     */
    private readonly sessions = new Map<string, Queued<BotSessionNoticeEntry>>();
    private areSessionsSettled = false;
    private sessionTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * Sessions running a task Caxri Bot dispatched (`active`), or until when a settled one keeps covering them. The
     * delegation notices already report those Sessions, so their state changes would only repeat it.
     */
    private readonly delegated = new Map<string, number | 'active'>();

    constructor(private readonly options: BotQueuedNoticesOptions) {}

    get size(): number {
        return this.inbox.size + this.handovers.size + this.sessions.size;
    }

    putInbox(entry: BotInboxNoticeEntry): void {
        this.inbox.set(entry.itemId, { ...entry, queuedAt: this.options.now() });
    }

    putHandover(entry: BotHandoverNoticeEntry): void {
        this.handovers.set(entry.handoverId, { ...entry, queuedAt: this.options.now() });
    }

    /**
     * Drops every queued Inbox event, for Clear Caxri Bot Data: the items they name no longer exist.
     */
    forgetInbox(): void {
        this.inbox.clear();
    }

    /**
     * Records a task Caxri Bot dispatched into `sessionId` changing to `status`.
     */
    observeDelegation(sessionId: string, status: AgentDelegationReceipt['status']): void {
        this.delegated.set(
            sessionId,
            isActiveDelegationStatus(status)
                ? 'active'
                : this.options.now() + SETTLED_DELEGATION_COVER_MS,
        );
    }

    /**
     * Whether a task Caxri Bot dispatched already reports this Session's activity.
     */
    isDelegated(sessionId: string): boolean {
        const cover = this.delegated.get(sessionId);
        if (cover === undefined) return false;
        if (cover === 'active' || cover > this.options.now()) return true;
        this.delegated.delete(sessionId);
        return false;
    }

    putSession(sessionId: string, state: BotSessionNoticeState): void {
        const now = this.options.now();
        const queuedAt = this.sessions.get(sessionId)?.queuedAt ?? now;
        this.sessions.set(sessionId, { sessionId, state, queuedAt });
        if (this.areSessionsSettled) return;
        const { quietMs, maxWaitMs } = this.options.sessionTiming ?? SESSION_NOTICE_TIMING;
        const oldest = Math.min(...this.sessions.values().map((entry) => entry.queuedAt));
        clearTimeout(this.sessionTimer);
        this.sessionTimer = setTimeout(
            () => {
                this.sessionTimer = undefined;
                this.areSessionsSettled = true;
                this.options.onSessionsSettled();
            },
            Math.max(0, Math.min(quietMs, oldest + maxWaitMs - now)),
        );
        // A pending batch must not keep an otherwise idle Server Core alive.
        this.sessionTimer.unref();
    }

    /**
     * What may go out now. Session changes nothing else reports join when they settled or when anything else goes out:
     * another queued notice, `hasOtherNotices`, or a launch prompt, which is a natural batch boundary.
     */
    deliverable(hasOtherNotices: boolean): QueuedNoticeBatch {
        for (const sessionId of this.sessions.keys())
            if (this.isDelegated(sessionId)) this.sessions.delete(sessionId);
        const inbox = this.inbox.values().toArray();
        const handovers = this.handovers.values().toArray();
        const hasSessions =
            this.areSessionsSettled || hasOtherNotices || inbox.length + handovers.length > 0;
        return { inbox, handovers, sessions: hasSessions ? this.sessions.values().toArray() : [] };
    }

    /**
     * Removes what a delivered line or launch prompt reported; an entry replaced by a later event since stays owed.
     */
    consume({ inbox, handovers, sessions }: QueuedNoticeBatch): void {
        for (const entry of inbox)
            if (this.inbox.get(entry.itemId) === entry) this.inbox.delete(entry.itemId);
        for (const entry of handovers)
            if (this.handovers.get(entry.handoverId) === entry)
                this.handovers.delete(entry.handoverId);
        for (const entry of sessions)
            if (this.sessions.get(entry.sessionId) === entry) this.sessions.delete(entry.sessionId);
        if (this.sessions.size > 0) return;
        this.areSessionsSettled = false;
        clearTimeout(this.sessionTimer);
        this.sessionTimer = undefined;
    }
}
