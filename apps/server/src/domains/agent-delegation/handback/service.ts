import { randomUUID } from 'node:crypto';

import type { DelegationHandBackRefusal, DelegationHandBackReply } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { StoredAgentDelegation, StoredDelegationHandBack } from '../../db';
import type { DelegationAuthority } from '../admission';
import { isCaxriBotCaller } from '../admission';
import type { DelegationFollowUpRejection } from '../rejection';
import { handBackRejection } from '../rejection';
import type { AgentDelegationServiceOptions } from '../service-options';
import { noticeCallerOf } from '../settlement-notice/eligibility';
import type { SettlementNotices } from '../settlement-notice/service';
import { handBackAnchor, sessionControls } from './control';

type HandBackOptions = Pick<
    AgentDelegationServiceOptions,
    | 'callerEndpoint'
    | 'chatCallerState'
    | 'currentLaunchId'
    | 'database'
    | 'inputEpoch'
    | 'isChatTerminal'
    | 'isIdle'
    | 'logger'
    | 'now'
>;

/**
 * What the grants borrow from the rest of the delegation service.
 */
interface HandBackHost {
    /**
     * True while a task is still running in the Terminal.
     */
    hasActiveTask(terminalId: string): boolean;
    /**
     * The settlement notices: they prove a Terminal Agent idle and its prompt free of unsent text, and tell the
     * delegating Agent that a grant exists.
     */
    notices(): SettlementNotices;
}

/**
 * Why a grant was dropped, as a closed enum for the log: what it was pinned to moved, or the Server restarted and none
 * of the pins can be proven any more.
 */
type InvalidationReason = 'child_changed' | 'parent_changed' | 'restart';

/**
 * Who asked for the hand-back: the owner (`user`: the button or `caxri agent delegate hand-back`), or Server Core after
 * the user left the taken-over Session alone (`auto`, see `DelegationAutoHandBack`).
 */
type HandBackTrigger = 'auto' | 'user';

/**
 * A refused hand-back, before the caller decides whether to throw it (the owner's request) or keep waiting (automatic).
 */
interface Refused {
    refusal: DelegationHandBackRefusal;
}

/**
 * What an automatic hand-back attempt ended with: the grant (`granted`, or `duplicate` when one was already pending),
 * or the refusal the owner's request would have thrown.
 */
export type AutoHandBackOutcome = DelegationHandBackReply['status'] | DelegationHandBackRefusal;

/**
 * The refusals that only mean "not yet": the child is mid-turn or its Terminal prompt holds unsent text. An automatic
 * hand-back waits them out; every other refusal ends its wait.
 */
export function isRetryableAutoRefusal(refusal: DelegationHandBackRefusal): boolean {
    return refusal === 'child_busy' || refusal === 'draft_active';
}

const REFUSAL_MESSAGES: Record<DelegationHandBackRefusal, string> = {
    not_taken_over: 'This Session is not under your control',
    child_busy: 'Wait for the current reply to finish before handing back',
    draft_active: 'Send or clear the text typed in the Terminal prompt before handing back',
    child_changed: 'This Session changed and can no longer be handed back',
    parent_gone: 'The delegating Agent is no longer running',
    parent_changed: 'The delegating Agent is no longer the one that delegated this Session',
};

/**
 * The follow-up refusals that mean something the grant was pinned to moved, as opposed to a transient clash with
 * another request: the grant is dropped for these, and kept for `parent_chained` and `terminal_busy`.
 */
const PIN_REFUSALS: ReadonlySet<DelegationFollowUpRejection> = new Set([
    'no_terminal',
    'target_lost',
    'launch_replaced',
    'input_epoch_moved',
    'target_not_idle',
]);

/**
 * The user's explicit "you may continue this" for a Session they took over: a single-use grant that lets the Agent that
 * delegated the Session follow up its newest task again, as a new task in the same Terminal and conversation. The old
 * tasks keep their takeover mark, history, and cost, and a hand-back sends nothing to the child. See
 * `docs/agent-delegation.md`.
 *
 * The grant is pinned to the child's launch, provider conversation, finished turn, and input epoch, and to the
 * delegating Agent's Terminal and launch, so anything that happened in the Session after the user gave it back drops
 * the grant before the follow-up could use it.
 */
export class DelegationHandBacks {
    constructor(
        private readonly options: HandBackOptions,
        private readonly host: HandBackHost,
    ) {}

    private get store() {
        return this.options.database.agentDelegations.handBacks;
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    private log(
        outcome: 'consumed' | 'duplicate' | 'granted' | 'invalidated' | DelegationHandBackRefusal,
        extra: { reason?: InvalidationReason; count?: number; trigger?: HandBackTrigger } = {},
    ): void {
        this.options.logger?.write('info', logEventCatalog.agentDelegation.handBack, {
            fields: { outcome, ...extra },
        });
    }

    private refuse(reason: DelegationHandBackRefusal): Refused {
        return { refusal: reason };
    }

    private invalidate(ids: readonly string[], reason: InvalidationReason): void {
        const { length: count } = this.store.invalidate(ids, this.now());
        if (count > 0) this.log('invalidated', { reason, count });
    }

    /**
     * Checks the Session's Agent can take a new instruction right now, and returns what the grant pins of it, or the
     * refusal.
     */
    private pinsOfChild(anchor: StoredAgentDelegation) {
        const { database } = this.options;
        const { sessionId, terminalId } = anchor.receipt;
        const terminal = terminalId ? database.getTerminal(terminalId) : undefined;
        const launchId = terminalId && this.options.currentLaunchId?.(terminalId);
        const session = database.getSession(sessionId);
        if (
            !launchId ||
            !terminalId ||
            !terminal ||
            terminal.sessionId !== sessionId ||
            session?.archivedAt !== undefined ||
            launchId !== anchor.launchId ||
            !terminal.agentSessionId ||
            terminal.agentSessionId !== anchor.providerSessionId
        )
            return this.refuse('child_changed');
        const inputEpoch = this.options.inputEpoch?.(terminalId);
        if (inputEpoch === undefined) return this.refuse('child_changed');
        if (this.host.hasActiveTask(terminalId)) return this.refuse('child_busy');
        if (
            this.options.isChatTerminal?.(terminalId) &&
            this.options.chatCallerState?.(terminalId) !== 'idle'
        )
            return this.refuse('child_busy');
        const turnId = this.host.notices().childIdleTurn(terminalId, launchId);
        if (!turnId) return this.refuse('child_busy');
        // A pasted follow-up ends in Enter, so it would submit the user's half-typed line with it.
        if (
            !this.options.isChatTerminal?.(terminalId) &&
            this.host.notices().hasDraft(terminalId, launchId)
        )
            return this.refuse('draft_active');
        return {
            terminalId,
            launchId,
            providerSessionId: terminal.agentSessionId,
            turnId,
            inputEpoch,
        };
    }

    /**
     * Checks the Agent that delegated the Session is still the same running launch, and returns what the grant pins of
     * it, or the refusal.
     */
    private pinsOfParent(anchor: StoredAgentDelegation) {
        const { database } = this.options;
        const caller = noticeCallerOf(database, anchor);
        if ('reason' in caller) return this.refuse('parent_gone');
        const terminal = database.getTerminal(caller.terminalId);
        if (!terminal || database.getSession(terminal.sessionId)?.archivedAt !== undefined)
            return this.refuse('parent_gone');
        const launchId = this.options.currentLaunchId?.(caller.terminalId);
        if (!launchId) return this.refuse('parent_gone');
        if (launchId !== caller.launchId) return this.refuse('parent_changed');
        const { principal } = anchor;
        if (this.options.callerEndpoint && principal.kind === 'agent') {
            const endpoint = this.options.callerEndpoint(caller.terminalId);
            if (!endpoint) return this.refuse('parent_gone');
            if (
                endpoint.endpointId !== principal.endpointId ||
                endpoint.generation !== principal.generation
            )
                return this.refuse('parent_changed');
        }
        return { callerTerminalId: caller.terminalId, callerLaunchId: caller.launchId };
    }

    /**
     * Stores a grant for the Session through every guard, or answers the refusal. Shared by the owner's request and the
     * automatic hand-back, which differ only in how they report a refusal.
     */
    private grant(sessionId: string, trigger: HandBackTrigger): DelegationHandBackReply | Refused {
        const { database } = this.options;
        const relation = database.getSession(sessionId)?.createdByRelation;
        if (relation !== 'delegated' && relation !== 'consult')
            return this.refuse('not_taken_over');
        const control = sessionControls(database, [sessionId]).get(sessionId);
        if (control === 'handback_pending') {
            const pending = database.agentDelegations.handBacks
                .forSessions([sessionId])
                .find((grant) => grant.state === 'pending')!;
            this.log('duplicate', { trigger });
            return { grantId: pending.id, delegationId: pending.delegationId, status: 'duplicate' };
        }
        const anchor = handBackAnchor(database, sessionId);
        if (control !== 'human' || !anchor?.hasHumanIntervention)
            return this.refuse('not_taken_over');
        const child = this.pinsOfChild(anchor);
        if ('refusal' in child) return child;
        const parent = this.pinsOfParent(anchor);
        if ('refusal' in parent) return parent;
        const grant = {
            id: randomUUID(),
            delegationId: anchor.receipt.delegationId,
            sessionId,
            ...child,
            ...parent,
            createdAt: this.now(),
        };
        if (!this.store.insert(grant)) {
            this.log('duplicate', { trigger });
            return { grantId: grant.id, delegationId: grant.delegationId, status: 'duplicate' };
        }
        this.log('granted', { trigger });
        this.host.notices().handedBack(anchor, grant.id);
        return { grantId: grant.id, delegationId: grant.delegationId, status: 'granted' };
    }

    /**
     * `agent.delegation.handBack`. `delegationId` names any task of the Session; the grant continues the Session's
     * newest task that ran.
     */
    handBack(delegationId: string): DelegationHandBackReply {
        const named = this.options.database.agentDelegations.get(delegationId);
        if (!named) throw new CaxriError('NOT_FOUND', 'Delegation is unavailable');
        const result = this.grant(named.receipt.sessionId, 'user');
        if (!('refusal' in result)) return result;
        const reason = result.refusal;
        this.log(reason, { trigger: 'user' });
        throw new CaxriError('CONFLICT', REFUSAL_MESSAGES[reason], { reason });
    }

    /**
     * Hands `sessionId` back on the user's behalf after they left it alone (`DelegationAutoHandBack`), through the same
     * guards as their own request. Never throws: the refusal is the answer. Only a refusal that ends the wait is
     * logged, so a child that stays busy for an hour does not log one every sweep.
     */
    autoHandBack(sessionId: string): AutoHandBackOutcome {
        const result = this.grant(sessionId, 'auto');
        if (!('refusal' in result)) return result.status;
        if (!isRetryableAutoRefusal(result.refusal)) this.log(result.refusal, { trigger: 'auto' });
        return result.refusal;
    }

    /**
     * Whether the grant still stands, for the notice that tells the delegating Agent about it.
     */
    isPending(grantId: string): boolean {
        return this.store.get(grantId)?.state === 'pending';
    }

    /**
     * The pending grant a follow-up of `delegationId` would use, if any.
     */
    pendingFor(delegationId: string): StoredDelegationHandBack | undefined {
        return this.store.pendingForDelegation(delegationId);
    }

    /**
     * The first condition that keeps `grant` from carrying a follow-up of `parent`, or `undefined` when it can. A
     * condition that says something the grant was pinned to moved drops the grant, so a later request cannot use it
     * either.
     */
    rejection(
        grant: StoredDelegationHandBack,
        parent: StoredAgentDelegation,
        isBusy: (terminalId: string) => boolean,
        successorId: string,
    ): DelegationFollowUpRejection | undefined {
        const { database } = this.options;
        const currentCaller = this.options.currentLaunchId?.(grant.callerTerminalId);
        if (
            currentCaller !== grant.callerLaunchId ||
            !database.getTerminal(grant.callerTerminalId)
        ) {
            this.invalidate([grant.id], 'parent_changed');
            return 'launch_replaced';
        }
        const rejection = handBackRejection(grant, parent, this.options, isBusy, successorId);
        if (rejection && PIN_REFUSALS.has(rejection)) this.invalidate([grant.id], 'child_changed');
        return rejection;
    }

    /**
     * Uses the grant for the follow-up `taskId`; false when another request already did.
     */
    consume(grant: StoredDelegationHandBack, taskId: string): boolean {
        const isConsumed = this.store.consume(grant.id, taskId, this.now());
        if (isConsumed) this.log('consumed');
        return isConsumed;
    }

    /**
     * Gives the grant back after the Host refused the follow-up's write before anything reached the conversation.
     */
    release(grant: StoredDelegationHandBack, taskId: string): void {
        this.store.release(grant.id, taskId, this.now());
    }

    /**
     * Something happened in the child's Terminal after the hand-back (input, a turn, a launch change): the pins no
     * longer hold.
     */
    invalidateTerminal(terminalId: string): void {
        const pending = this.store.pendingForTerminal(terminalId);
        if (pending.length > 0)
            this.invalidate(
                pending.map((grant) => grant.id),
                'child_changed',
            );
    }

    /**
     * An Agent-originated (managed or external) fresh `create` into a Session the user took over, or handed back and
     * not yet continued, would start a second Agent beside the user's conversation. Refused with `session_taken_over`;
     * the owner's own creates and Caxri Bot are not Agent-originated in this sense.
     */
    assertFreshCreateAllowed(authority: DelegationAuthority, sessionId: string): void {
        const { database } = this.options;
        const { kind } = authority.principal;
        if (
            (kind !== 'agent' && kind !== 'delegation-client') ||
            isCaxriBotCaller(database, authority)
        )
            return;
        // While a grant is pending only the follow-up that uses it may start work; a fresh task would move its pins.
        const control = sessionControls(database, [sessionId]).get(sessionId);
        if (control !== 'human' && control !== 'handback_pending') return;
        throw new CaxriError(
            'CONFLICT',
            'The user took over this Session; it takes new work only after they hand it back',
            { reason: 'session_taken_over' },
        );
    }

    /**
     * After a Server restart none of the pins of a pending grant can be proven (the child's launch and input epoch are
     * new), so every one is dropped and the user hands the Session back again.
     */
    initialize(): void {
        const pending = this.store.pending();
        if (pending.length > 0)
            this.invalidate(
                pending.map((grant) => grant.id),
                'restart',
            );
    }
}
