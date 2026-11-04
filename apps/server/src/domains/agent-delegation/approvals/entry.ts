import type {
    AgentChatItem,
    AgentChatRequest,
    ApprovalDecision,
    ApprovalRequestKind,
    DelegationApprovalChanged,
} from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../../agents';
import type { Coverage } from './coverage';
import type { AppliedPermissionRead, ChainHop } from './evidence';
import type { RequestOffers } from './fingerprint';
import type { WorkspacePathResolver } from './paths';

/**
 * The state of a `fileChange` request's path check. `pending` is the short window before the asynchronous filesystem
 * check answers; the request is then provisionally covered.
 */
export type PathState =
    | { state: 'none' }
    | { state: 'pending' }
    | { state: 'known'; verdict: 'inside' | 'outside' | 'unproven' | 'absent' };

/**
 * One permission request of a delegated Chat that the delegating Agent may decide. In memory only: a Server Core
 * restart loses the provider's requests too. Holds ids and closed values; request content is always read live from the
 * Chat and never kept here, so nothing in an entry can reach a log or an event.
 */
export interface PendingApproval {
    requestId: string;
    delegationId: string;
    sessionId: string;
    childTerminalId: string;
    childLaunchId: string;
    /**
     * Identity of the Session's authorized root at request time, as JSON.
     */
    binding: string;
    turnId: string;
    inputEpoch: number | undefined;
    /**
     * SHA-256 over the whole projected request and its offered decisions. Any change is a different request.
     */
    fingerprint: string;
    /**
     * Bumps on every reclassification, so an asynchronous continuation can tell it is stale.
     */
    version: number;
    kind: ApprovalRequestKind;
    coverage: Coverage;
    path: PathState;
    /**
     * Every Agent above the task, direct parent first; drives the takeover and retirement cascade.
     */
    chain: readonly ChainHop[];
    /**
     * Preserved across reclassification, so a request edited late cannot extend the grace.
     */
    requestedAt: number;
    /**
     * Monotonic: once the user has been shown the request, it never becomes the delegating Agent's again.
     */
    escalatedAt?: number;
    /**
     * `held` while the Session record write that alerts the user is suppressed; `raised` once it ran (or was never
     * held).
     */
    alert: 'held' | 'raised';
    /**
     * The lifecycle signal whose alert is held: ids only.
     */
    heldSignal: AgentLifecycleSignal;
    /**
     * Set while the delegating Agent's own answer is being delivered, so the progress that answer causes does not read
     * as the request being resolved elsewhere.
     */
    deciding?: boolean;
    timer?: NodeJS.Timeout;
}

/**
 * What approval handling borrows from the Chat, the provider, and the settings. Late-bound by the composition root; a
 * service built without it never holds or covers a request.
 */
export interface DelegationApprovalEnvironment {
    /**
     * `agents.delegation.approval`, read live.
     */
    enabled(): boolean;
    appliedPermission(terminalId: string): AppliedPermissionRead | undefined;
    /**
     * The Chat's pending requests and active turn now, or `undefined` for a Terminal that is not a live Chat.
     */
    chat(
        terminalId: string,
    ): { requests: readonly AgentChatRequest[]; activeTurnId?: string } | undefined;
    offers(terminalId: string, requestId: string): RequestOffers | undefined;
    /**
     * Answers a request exactly as the user's own click would, without counting as human input. Throws `CONFLICT` when
     * the request is no longer pending and `VALIDATION` when the provider refuses the decision.
     */
    respond(terminalId: string, requestId: string, decision: ApprovalDecision): void;
    resolveWorkspacePath: WorkspacePathResolver;
    applyItem(terminalId: string, item: AgentChatItem): void;
    /**
     * Shows a request the alert of which was held; false when the provider already resolved it.
     */
    raiseAttention(signal: AgentLifecycleSignal): boolean;
    onChanged(change: DelegationApprovalChanged): void;
    /**
     * Calls `listener` after any setting changed; returns the unsubscribe.
     */
    onSettingsChanged?(listener: () => void): () => void;
}
