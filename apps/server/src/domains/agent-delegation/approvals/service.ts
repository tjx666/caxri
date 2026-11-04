import process from 'node:process';

import type {
    ApprovalCancelReason,
    ApprovalDecision,
    ApprovalEscalationReason,
    DelegationApproval,
    DelegationApprovalChanged,
    DelegationApproveResult,
} from '@caxri/protocol';
import { APPROVAL_REQUEST_CHANGED, CaxriError, logEventCatalog } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../../agents';
import type { StoredAgentDelegation } from '../../db';
import type { DelegationAccess, DelegationAuthority } from '../admission';
import type { ParentPresence } from '../parent-presence';
import type { AgentDelegationServiceOptions } from '../service-options';
import type { Coverage } from './coverage';
import { approvalCoverage } from './coverage';
import { resolveApprovalGraceMs } from './e2e-grace';
import type { PathState, PendingApproval } from './entry';
import { hopEvidence, walkChain } from './evidence';
import type { HeldRequest } from './facts';
import {
    commandText,
    conflict,
    entryStaleness,
    heldSignalOf,
    isHeldKind,
    PATH_REASONS,
    pathVerdictOf,
    unavailable,
} from './facts';
import type { RequestOffers } from './fingerprint';
import { requestFingerprint, revisionOf } from './fingerprint';
import { pathVerdict } from './paths';
import { approvalFeed, approvalView } from './view';

/**
 * What the approvals facade borrows from the delegation service.
 */
export interface DelegationApprovalsHost {
    options: Pick<
        AgentDelegationServiceOptions,
        'database' | 'logger' | 'approvals' | 'currentLaunchId' | 'inputEpoch'
    >;
    now(): number;
    isClosed(): boolean;
    presence: ParentPresence;
    activeForTerminal(terminalId: string): StoredAgentDelegation | undefined;
    owned(
        id: string,
        authority: DelegationAuthority,
        access: DelegationAccess,
    ): StoredAgentDelegation;
}

/**
 * The permission requests of a delegated Chat that the Agent that delegated it may decide within its own permission. A
 * covered request is held quietly for a grace period (`APPROVAL_ESCALATION_GRACE_MS`): the Chat takes the ordinary
 * lifecycle, and only the Session record write that alerts the user is suppressed. Whatever ends the hold with the
 * request still pending, the grace elapsing, the delegating Agent going away, a setting or permission change, a
 * takeover, raises that alert exactly once. See `docs/agent-delegation.md`.
 */
export class DelegationApprovals {
    private readonly entries = new Map<string, PendingApproval[]>();
    private readonly graceMs = resolveApprovalGraceMs(process.env);
    private readonly unsubscribeSettings?: () => void;

    constructor(private readonly host: DelegationApprovalsHost) {
        this.unsubscribeSettings = host.options.approvals?.onSettingsChanged?.(() =>
            this.settingsChanged(),
        );
    }

    private get env() {
        return this.host.options.approvals;
    }

    private binding(sessionId: string): string {
        return JSON.stringify(this.host.options.database.getSessionWorkbenchBinding(sessionId));
    }

    private all(): PendingApproval[] {
        return this.entries.values().toArray().flat();
    }

    private isTracked(entry: PendingApproval): boolean {
        return this.entries.get(entry.delegationId)?.includes(entry) === true;
    }

    private liveRequest(entry: PendingApproval): HeldRequest | undefined {
        const request = this.env
            ?.chat(entry.childTerminalId)
            ?.requests.find((candidate) => candidate.id === entry.requestId);
        return isHeldKind(request) ? request : undefined;
    }

    private emit(entry: PendingApproval, state: DelegationApprovalChanged['state']): void {
        this.env?.onChanged({
            sessionId: entry.sessionId,
            delegationId: entry.delegationId,
            requestId: entry.requestId,
            state,
        });
    }

    private insert(entry: PendingApproval): void {
        const list = this.entries.get(entry.delegationId) ?? [];
        list.push(entry);
        this.entries.set(entry.delegationId, list);
    }

    private remove(entry: PendingApproval): void {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        const list = this.entries.get(entry.delegationId)?.filter((other) => other !== entry);
        if (list?.length) this.entries.set(entry.delegationId, list);
        else this.entries.delete(entry.delegationId);
    }

    /**
     * Judges one request against the delegating Agents' own permission, now, from stored records and live evidence.
     */
    private assess(
        task: StoredAgentDelegation,
        request: HeldRequest,
        input: { turnProven: boolean; path: PathState; offers: RequestOffers | undefined },
    ): { coverage: Coverage; hops: ReturnType<typeof walkChain>['hops'] } {
        const environment = this.env!;
        const { options } = this.host;
        const walked = walkChain(options, task);
        const evidenceHost = {
            database: options.database,
            currentLaunchId: options.currentLaunchId,
            appliedPermission: (terminalId: string) => environment.appliedPermission(terminalId),
        };
        const coverage = approvalCoverage({
            enabled: environment.enabled(),
            chain: walked.hops.map((hop) => hopEvidence(evidenceHost, hop)),
            lineageProven: walked.lineageProven,
            request: {
                kind: request.kind,
                hasNetworkHost: request.kind === 'command' && Boolean(request.networkHost),
                isExitPlan: false,
                takenOver: Boolean(task.hasHumanIntervention),
                turnProven: input.turnProven,
                acceptOffered: input.offers?.accept === true,
                commandText: commandText(request),
                pathVerdict: pathVerdictOf(input.path),
            },
        });
        return { coverage, hops: walked.hops };
    }

    /**
     * Builds the entry for a request, carrying over what a replacement must not reset.
     */
    private build(
        task: StoredAgentDelegation,
        request: HeldRequest,
        signal: AgentLifecycleSignal,
        prior?: PendingApproval,
    ): PendingApproval {
        const environment = this.env!;
        const childTerminalId = task.receipt.terminalId!;
        const offers = environment.offers(childTerminalId, request.id);
        const path: PathState =
            request.kind !== 'fileChange'
                ? { state: 'none' }
                : request.paths?.length
                  ? { state: 'pending' }
                  : { state: 'known', verdict: 'absent' };
        const turnId = signal.agentTurnId ?? '';
        const { coverage, hops } = this.assess(task, request, {
            turnProven: turnId !== '' && turnId === task.turnId,
            path,
            offers,
        });
        const now = this.host.now();
        return {
            requestId: request.id,
            delegationId: task.receipt.delegationId,
            sessionId: task.receipt.sessionId,
            childTerminalId,
            childLaunchId: task.launchId!,
            binding: this.binding(task.receipt.sessionId),
            turnId,
            inputEpoch: this.host.options.inputEpoch?.(childTerminalId),
            fingerprint: requestFingerprint(request, offers),
            version: (prior?.version ?? 0) + 1,
            kind: request.kind,
            coverage,
            path,
            chain: hops,
            requestedAt: prior?.requestedAt ?? now,
            heldSignal: heldSignalOf(signal),
            ...(prior?.escalatedAt !== undefined || !coverage.covered
                ? { escalatedAt: prior?.escalatedAt ?? now, alert: prior?.alert ?? 'raised' }
                : { alert: 'held' }),
        };
    }

    private log(
        level: 'info' | 'warn',
        event: keyof typeof logEventCatalog.agentDelegation,
        entry: PendingApproval,
        fields: Record<string, string | number>,
    ): void {
        this.host.options.logger?.write(level, logEventCatalog.agentDelegation[event], {
            fields: { delegationId: entry.delegationId, requestKind: entry.kind, ...fields },
        });
    }

    /**
     * Starts the clock of a covered, unescalated entry; the deadline is its first request time plus the grace.
     */
    private arm(entry: PendingApproval): void {
        clearTimeout(entry.timer);
        const delay = Math.max(0, entry.requestedAt + this.graceMs - this.host.now());
        entry.timer = setTimeout(() => {
            entry.timer = undefined;
            if (this.isTracked(entry)) this.escalate(entry, 'grace_elapsed');
        }, delay);
        entry.timer.unref();
    }

    /**
     * Shows a held request to the user: the one Session record write the quiet signal skipped. Idempotent, and a no-op
     * once the provider no longer lists the request.
     */
    private release(entry: PendingApproval): void {
        if (entry.alert !== 'held') return;
        entry.alert = 'raised';
        if (this.liveRequest(entry)) this.env?.raiseAttention(entry.heldSignal);
    }

    /**
     * Hands the request to the user. Monotonic: it never returns to the delegating Agent's own decision window, but a
     * covered escalated request stays approvable until the user answers first.
     */
    private escalate(entry: PendingApproval, reason: ApprovalEscalationReason): void {
        if (entry.escalatedAt !== undefined && entry.alert === 'raised') return;
        clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.escalatedAt ??= this.host.now();
        this.log('warn', 'approvalEscalated', entry, {
            escalationReason: reason,
            latencyMs: this.host.now() - entry.requestedAt,
        });
        this.release(entry);
        this.emit(entry, 'escalated');
    }

    /**
     * Ends an entry without the delegating Agent's decision. Whatever left the request still pending in the Chat is
     * shown to the user first.
     */
    private cancel(entry: PendingApproval, reason: ApprovalCancelReason): void {
        if (!this.isTracked(entry)) return;
        if (reason !== 'resolved_elsewhere') this.release(entry);
        this.remove(entry);
        this.log('info', 'approvalCancelled', entry, {
            cancelReason: reason,
            latencyMs: this.host.now() - entry.requestedAt,
        });
        this.emit(entry, 'cancelled');
    }

    /**
     * Brings a changed request back under judgment. Both providers overwrite a request with the same ID in place and
     * send no second attention signal, so the entry is rebuilt from what the Chat holds now. The first request time is
     * kept, so editing a request late never extends the grace, and an escalation is kept.
     */
    private reclassify(entry: PendingApproval, request: HeldRequest): void {
        const task = this.host.activeForTerminal(entry.childTerminalId);
        if (
            !task ||
            task.receipt.delegationId !== entry.delegationId ||
            task.launchId !== entry.childLaunchId
        )
            return this.cancel(entry, 'task_ended');
        this.remove(entry);
        this.log('info', 'approvalCancelled', entry, {
            cancelReason: 'request_changed',
            latencyMs: this.host.now() - entry.requestedAt,
        });
        const next = this.build(task, request, entry.heldSignal, entry);
        this.insert(next);
        this.start(next, request, 'request_changed');
    }

    /**
     * Finishes setting up a freshly built entry: the grace clock and path check of a covered one, the escalation of one
     * that is not.
     */
    private start(
        entry: PendingApproval,
        request: HeldRequest,
        uncoveredReason: ApprovalEscalationReason,
    ) {
        if (entry.escalatedAt !== undefined) {
            if (entry.alert === 'held') this.escalate(entry, uncoveredReason);
        } else if (!entry.coverage.covered) this.escalate(entry, uncoveredReason);
        else if (entry.chain.some((hop) => this.host.presence.isGone(hop.terminalId, hop.launchId)))
            this.escalate(entry, 'parent_gone');
        else this.arm(entry);
        // An escalated entry still needs its verdict: until the check answers, status and feed hide the request and
        // the delegating Agent is refused with `path_unproven`.
        if (entry.path.state === 'pending') this.checkPaths(entry, request);
    }

    private checkPaths(entry: PendingApproval, request: HeldRequest): void {
        if (request.kind !== 'fileChange') return;
        const { version, fingerprint, binding } = entry;
        const settle = (verdict: 'inside' | 'outside' | 'unproven' | 'absent') => {
            if (
                this.host.isClosed() ||
                !this.isTracked(entry) ||
                entry.version !== version ||
                entry.fingerprint !== fingerprint
            )
                return;
            if (this.binding(entry.sessionId) !== binding)
                return this.cancel(entry, 'binding_changed');
            entry.path = { state: 'known', verdict };
            if (verdict === 'inside' || entry.escalatedAt !== undefined)
                return this.emit(entry, entry.escalatedAt === undefined ? 'pending' : 'escalated');
            entry.coverage = { covered: false, reason: PATH_REASONS[verdict] };
            this.escalate(entry, 'uncovered');
        };
        const resolve = this.env!.resolveWorkspacePath;
        void (async () => {
            try {
                settle(await pathVerdict(resolve, entry.sessionId, request.paths));
            } catch {
                settle('unproven');
            }
        })();
    }

    private settingsChanged(): void {
        if (this.env?.enabled() !== false) return;
        for (const entry of this.all())
            if (entry.escalatedAt === undefined) this.escalate(entry, 'settings_changed');
    }

    private refuse(entry: PendingApproval, refusal: string): void {
        this.log('warn', 'approvalRefused', entry, { refusal });
    }

    /**
     * Whether the delegating Agent may still decide the entry now, from fresh evidence. A request judged uncovered when
     * it arrived is never decidable. One no longer covered is handed to the user at once, and an unfinished path check
     * refuses without escalating because its verdict is moments away.
     */
    private coverageRefusal(
        task: StoredAgentDelegation,
        entry: PendingApproval,
        request: HeldRequest,
        offers: RequestOffers | undefined,
    ): { reason: string } | undefined {
        if (!entry.coverage.covered) return { reason: entry.coverage.reason };
        if (entry.path.state === 'pending') return { reason: 'path_unproven' };
        const { coverage } = this.assess(task, request, {
            turnProven: true,
            path: entry.path,
            offers,
        });
        if (coverage.covered) return undefined;
        entry.coverage = coverage;
        const { reason } = coverage;
        this.escalate(entry, reason === 'ancestor_taken_over' ? reason : 'permission_revoked');
        return { reason };
    }

    /**
     * Decides, synchronously and before the coordinator sees the signal, whether a Chat's `attentionRequested` is shown
     * now (`alert`) or held for the delegating Agent (`quiet`). A request it does not cover, and every question or tool
     * request, takes the ordinary alert.
     */
    classify(signal: AgentLifecycleSignal): 'alert' | 'quiet' {
        const environment = this.env;
        if (!environment || this.host.isClosed() || signal.agentId) return 'alert';
        if (signal.phase !== 'attentionRequested' || !signal.agentToolUseId) return 'alert';
        const task = this.host.activeForTerminal(signal.terminalId);
        if (!task?.launchId || task.launchId !== signal.launchId) return 'alert';
        const request = environment
            .chat(signal.terminalId)
            ?.requests.find((candidate) => candidate.id === signal.agentToolUseId);
        if (!isHeldKind(request)) return 'alert';
        const stale = this.entries
            .get(task.receipt.delegationId)
            ?.find((candidate) => candidate.requestId === request.id);
        if (stale) this.cancel(stale, 'request_changed');
        const entry = this.build(task, request, signal);
        this.insert(entry);
        this.log('info', 'approvalRequested', entry, {
            coverageReason: entry.coverage.covered ? 'covered' : entry.coverage.reason,
        });
        this.emit(entry, entry.escalatedAt === undefined ? 'pending' : 'escalated');
        this.start(entry, request, 'uncovered');
        return entry.alert === 'held' ? 'quiet' : 'alert';
    }

    /**
     * After a Chat's projection changed: an entry whose request left the projection is dropped with no alert, and one
     * whose request changed is judged again.
     */
    observe(terminalId: string): void {
        if (this.entries.size === 0) return;
        const chat = this.env?.chat(terminalId);
        for (const entry of this.all()) {
            if (entry.childTerminalId !== terminalId || entry.deciding) continue;
            // react-doctor-disable-next-line react-doctor/js-index-maps -- a Chat holds a handful of open requests
            const request = chat?.requests.find((candidate) => candidate.id === entry.requestId);
            if (!request) this.cancel(entry, 'resolved_elsewhere');
            else if (
                !isHeldKind(request) ||
                requestFingerprint(request, this.env!.offers(terminalId, entry.requestId)) !==
                    entry.fingerprint
            ) {
                if (isHeldKind(request)) this.reclassify(entry, request);
                else this.cancel(entry, 'request_changed');
            }
        }
    }

    viewFor(delegationId: string): DelegationApproval | undefined {
        return approvalView(this.entries, this.host.options, delegationId);
    }

    feed(delegationIds: readonly string[]) {
        return approvalFeed(this.entries, this.env, delegationIds);
    }

    /**
     * The delegating Agent's decision on one request. Everything between the checks and the answer to the Chat runs in
     * one tick, so the decision either reaches the request as it was judged or fails; a user who answers first wins at
     * the provider's broker and the delegating Agent receives `CONFLICT`.
     */
    approve(
        authority: DelegationAuthority,
        input: {
            delegationId: string;
            requestId: string;
            decision: ApprovalDecision;
            revision: string;
        },
    ): DelegationApproveResult {
        const environment = this.env;
        if (!environment) throw unavailable();
        let task: StoredAgentDelegation;
        try {
            task = this.host.owned(input.delegationId, authority, 'existing');
        } catch (error) {
            throw error instanceof CaxriError ? unavailable() : error;
        }
        // The Agent that delegated the task, exactly: no client, owner, or Caxri Bot reaches a parent decision.
        if (
            authority.principal.kind !== 'agent' ||
            JSON.stringify(authority.principal) !== JSON.stringify(task.principal) ||
            authority.callerTerminalId !== task.receipt.callerTerminalId
        )
            throw unavailable();
        const entry = this.entries
            .get(input.delegationId)
            ?.find((candidate) => candidate.requestId === input.requestId);
        if (!entry) throw unavailable();
        // The decision is bound to the version the Agent read: a provider rewrite under the same ID is a new request.
        if (input.revision !== revisionOf(entry.fingerprint)) {
            this.refuse(entry, APPROVAL_REQUEST_CHANGED);
            throw conflict(APPROVAL_REQUEST_CHANGED);
        }
        const stale = entryStaleness(task, entry, this.host.options, () =>
            this.binding(entry.sessionId),
        );
        if (stale) {
            this.cancel(entry, stale);
            this.refuse(entry, 'stale');
            throw conflict();
        }
        const chat = environment.chat(entry.childTerminalId);
        const request = chat?.requests.find((candidate) => candidate.id === entry.requestId);
        if (!isHeldKind(request)) {
            this.cancel(entry, 'resolved_elsewhere');
            throw conflict();
        }
        if (chat?.activeTurnId !== entry.turnId) {
            this.cancel(entry, 'turn_changed');
            throw conflict();
        }
        const offers = environment.offers(entry.childTerminalId, entry.requestId);
        if (requestFingerprint(request, offers) !== entry.fingerprint) {
            this.refuse(entry, 'stale');
            this.reclassify(entry, request);
            throw conflict();
        }
        const refusal = this.coverageRefusal(task, entry, request, offers);
        if (refusal) {
            this.refuse(entry, refusal.reason);
            throw new CaxriError('FORBIDDEN', 'The delegating Agent cannot decide this request', {
                coverageReason: refusal.reason,
            });
        }
        if (offers?.[input.decision] !== true)
            throw new CaxriError('VALIDATION', 'The provider does not offer this decision');
        entry.deciding = true;
        try {
            environment.respond(entry.childTerminalId, entry.requestId, input.decision);
        } catch (error) {
            entry.deciding = false;
            if (error instanceof CaxriError && error.code === 'CONFLICT') {
                this.cancel(entry, 'resolved_elsewhere');
                throw conflict();
            }
            throw error;
        }
        this.remove(entry);
        this.log('info', 'approvalDecided', entry, {
            decision: input.decision,
            latencyMs: this.host.now() - entry.requestedAt,
        });
        this.emit(entry, 'decided');
        environment.applyItem(entry.childTerminalId, {
            type: 'notice',
            id: `delegation-approval:${entry.requestId}`,
            turnId: entry.turnId,
            kind: 'delegationApproval',
        });
        return { outcome: input.decision === 'accept' ? 'approved' : 'declined' };
    }

    /**
     * Whether the delegating Agent still holds this request quietly; unknown requests are not held.
     */
    isHeld(terminalId: string, requestId: string): boolean {
        return this.all().some(
            (entry) =>
                entry.childTerminalId === terminalId &&
                entry.requestId === requestId &&
                entry.escalatedAt === undefined &&
                entry.alert === 'held',
        );
    }

    /**
     * A task ended (settled, stopped, or failed): its requests can no longer be decided.
     */
    taskEnded(delegationId: string): void {
        const held = this.entries.get(delegationId) ?? [];
        for (const entry of held) this.cancel(entry, 'task_ended');
    }

    /**
     * A Terminal interruption. A person typing in the delegated Chat makes its requests the user's (`taken_over`);
     * typing in a delegating Agent that is itself a delegated task hands every request below it to the user, while
     * input to the root Agent (no task to take over) is direction. A launch retiring takes its own requests with it and
     * escalates the requests whose delegating Agent it was.
     */
    interrupted(terminalId: string, isHumanInput: boolean, retiredLaunchId?: string): void {
        if (retiredLaunchId) this.host.presence.retire(retiredLaunchId);
        for (const entry of this.all()) {
            if (entry.childTerminalId === terminalId) {
                if (isHumanInput) this.cancel(entry, 'taken_over');
                else if (retiredLaunchId === entry.childLaunchId)
                    this.cancel(entry, 'child_launch_changed');
            } else if (entry.escalatedAt === undefined) {
                const hop = entry.chain.find((candidate) => candidate.terminalId === terminalId);
                if (isHumanInput && hop?.delegationId) {
                    entry.coverage = { covered: false, reason: 'ancestor_taken_over' };
                    this.escalate(entry, 'ancestor_taken_over');
                } else if (hop && !isHumanInput && retiredLaunchId === hop.launchId)
                    this.escalate(entry, 'parent_gone');
            }
        }
    }

    /**
     * Server Core restarted: every provider request is gone.
     */
    reset(): void {
        for (const entry of this.all()) this.cancel(entry, 'host_reset');
    }

    forget(sessionIds: readonly string[]): void {
        const doomed = new Set(sessionIds);
        for (const entry of this.all())
            if (doomed.has(entry.sessionId)) this.cancel(entry, 'task_ended');
    }

    close(): void {
        this.unsubscribeSettings?.();
        for (const entry of this.all()) clearTimeout(entry.timer);
        this.entries.clear();
    }
}
