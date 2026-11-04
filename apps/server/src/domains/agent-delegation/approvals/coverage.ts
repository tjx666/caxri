import type { AgentChatPermissionMode, ApprovalCoverageReason } from '@caxri/protocol';

/**
 * What one Agent of the delegation chain contributes to a request's coverage. The chain lists every Agent from the one
 * that delegated the task upward, direct parent first (see `walkChain`). Ids and closed values only.
 */
export interface ParentEvidence {
    surface: 'chat' | 'terminal';
    provider?: string;
    /**
     * The live launch is the launch recorded for this hop, and the permission read came from that same launch.
     */
    launchProven: boolean;
    /**
     * The hop's own delegated task (none for the root hop, which is `intact`): `taken_over` once a person acted in its
     * Terminal, `inactive` once it settled.
     */
    taskState: 'intact' | 'taken_over' | 'inactive';
    /**
     * The applied mode only; `undefined` when unresolved or not applied.
     */
    mode?: AgentChatPermissionMode;
    modeUnapplied?: boolean;
    planMode?: boolean;
}

/**
 * The path check of a `fileChange`. `pending` means the asynchronous filesystem check has not finished: the request is
 * provisionally treated as inside, and a failing verdict escalates it.
 */
export type PathVerdict = 'inside' | 'outside' | 'unproven' | 'absent' | 'pending';

export interface CoverageRequest {
    kind: 'command' | 'fileChange' | 'tool' | 'question';
    hasNetworkHost: boolean;
    isExitPlan: boolean;
    /**
     * The child task's `hasHumanIntervention` at evaluation time.
     */
    takenOver: boolean;
    /**
     * The request's turn equals the delegation's turn.
     */
    turnProven: boolean;
    /**
     * The decision being made is offered by the provider. A provider-private fact, never derived from the projected
     * `decisions` (whose absence means every plain decision, and whose emptiness cannot be told from an unknown-only
     * list). For a decline this carries whether `decline` is offered.
     */
    acceptOffered: boolean;
    /**
     * `unproven` is a length at the 4096 projection cap, which the projection may have clipped.
     */
    commandText: 'present' | 'absent' | 'unproven';
    pathVerdict: PathVerdict;
}

export type Coverage = { covered: true } | { covered: false; reason: ApprovalCoverageReason };

type Capability = 'command' | 'insideFileChange';

/**
 * What each level lets its Agent do itself, as sets and not as a rank: the intersection over the chain is what a
 * request needs.
 */
const PERMITTED: Partial<Record<AgentChatPermissionMode, ReadonlySet<Capability>>> = {
    fullAccess: new Set<Capability>(['command', 'insideFileChange']),
    acceptEdits: new Set<Capability>(['insideFileChange']),
};

const COVERING_PROVIDERS = new Set(['claude', 'codex']);

/**
 * Whether the delegating Agents' own permission covers a delegated Chat's request. Pure, with no I/O. The first match
 * wins, in this order, so a reason is deterministic: the setting, takeover, turn, lineage, offered decision, request
 * kind, network, and command text; then each hop's state; then each hop's permission against what the request needs.
 */
export function approvalCoverage(input: {
    enabled: boolean;
    chain: readonly ParentEvidence[];
    lineageProven: boolean;
    request: CoverageRequest;
}): Coverage {
    const { enabled, chain, lineageProven, request } = input;
    const no = (reason: ApprovalCoverageReason): Coverage => ({ covered: false, reason });
    if (!enabled) return no('disabled');
    if (request.takenOver) return no('taken_over');
    if (!request.turnProven) return no('turn_unproven');
    if (!lineageProven || chain.length === 0) return no('lineage_unproven');
    if (!request.acceptOffered) return no('accept_not_offered');
    if (request.kind === 'tool' || request.kind === 'question' || request.isExitPlan)
        return no('kind_unsupported');
    if (request.hasNetworkHost) return no('network');
    if (request.kind === 'command' && request.commandText !== 'present')
        return no('command_unproven');
    for (const [index, hop] of chain.entries()) {
        if (hop.surface !== 'chat')
            return no(index === 0 ? 'parent_not_chat' : 'ancestor_not_covering');
        if (!hop.provider || !COVERING_PROVIDERS.has(hop.provider)) return no('parent_provider');
        if (!hop.launchProven) return no('parent_launch_unknown');
        if (hop.taskState === 'taken_over') return no('ancestor_taken_over');
        if (hop.taskState === 'inactive') return no('lineage_unproven');
        if (hop.modeUnapplied) return no('parent_mode_unapplied');
        if (hop.planMode) return no('parent_plan_mode');
        if (hop.mode === undefined) return no('parent_mode_unresolved');
    }
    if (request.kind === 'fileChange') {
        if (request.pathVerdict === 'absent') return no('path_missing');
        if (request.pathVerdict === 'outside') return no('path_outside');
        if (request.pathVerdict === 'unproven') return no('path_unproven');
    }
    const needs: Capability = request.kind === 'command' ? 'command' : 'insideFileChange';
    for (const [index, hop] of chain.entries())
        if (!PERMITTED[hop.mode!]?.has(needs))
            return no(index === 0 ? 'parent_mode_insufficient' : 'ancestor_not_covering');
    return { covered: true };
}
