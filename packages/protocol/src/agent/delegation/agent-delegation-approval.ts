import { z } from 'zod';

import { identifierSchema } from '../../domain/identifiers.js';

/**
 * How long a covered permission request waits for the Agent that delegated the task before the Session shows it to the
 * user, in milliseconds.
 */
export const APPROVAL_ESCALATION_GRACE_MS = 90_000;

/**
 * Most paths one approval reply lists. A request with more is never covered.
 */
export const MAX_APPROVAL_PATHS_IN_REPLY = 20;

/**
 * Reply field caps equal the request projection's own caps, so the delegating Agent never approves text shorter than
 * what coverage judged. A value at the cap may have been clipped, so it is never covered.
 */
const MAX_APPROVAL_COMMAND_CHARS = 4096;
export const MAX_APPROVAL_CWD_CHARS = 4096;
const MAX_APPROVAL_PATH_CHARS = 4096;

/**
 * Why a request is, or is not, covered by the delegating Agent's own permission. `covered` is the only reason that
 * allows an approval; every other value sends the request to the user.
 */
export const approvalCoverageReasonSchema = z.enum([
    'covered',
    'disabled',
    'parent_not_chat',
    'parent_provider',
    'parent_launch_unknown',
    'parent_mode_unresolved',
    'parent_mode_unapplied',
    'parent_plan_mode',
    'parent_mode_insufficient',
    'ancestor_not_covering',
    'ancestor_taken_over',
    'lineage_unproven',
    'taken_over',
    'turn_unproven',
    'kind_unsupported',
    'network',
    'command_unproven',
    'path_missing',
    'path_outside',
    'path_unproven',
    'accept_not_offered',
]);
export type ApprovalCoverageReason = z.infer<typeof approvalCoverageReasonSchema>;

/**
 * Log-only: why a covered request was handed to the user. Never a protocol payload field.
 */
export type ApprovalEscalationReason =
    | 'grace_elapsed'
    | 'parent_gone'
    | 'uncovered'
    | 'settings_changed'
    | 'permission_revoked'
    | 'ancestor_taken_over'
    | 'request_changed';

/**
 * Log-only: why a pending approval entry ended without a decision from the delegating Agent.
 */
export type ApprovalCancelReason =
    | 'taken_over'
    | 'host_reset'
    | 'task_ended'
    | 'child_launch_changed'
    | 'resolved_elsewhere'
    | 'turn_changed'
    | 'binding_changed'
    | 'request_changed';

const approvalRequestKindSchema = z.enum(['command', 'fileChange']);
export type ApprovalRequestKind = z.infer<typeof approvalRequestKindSchema>;

/**
 * What the delegating Agent may answer: `accept` or `decline`, a subset of the Chat decisions. Never a standing
 * approval.
 */
const approvalDecisionSchema = z.enum(['accept', 'decline']);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

const approvalRevisionSchema = z.string().min(1).max(64);

const approvalBase = {
    requestId: identifierSchema,
    kind: approvalRequestKindSchema,
    covered: z.boolean(),
    coverageReason: approvalCoverageReasonSchema,
    escalated: z.boolean(),
    requestedAt: z.number().int().positive(),
};

/**
 * A pending permission request of a delegated Chat, as the delegating Agent reads it in `wait` and `status`. The
 * content fields appear only in those replies, by design: they are what the delegating Agent judges, and they never
 * reach a log, an event, or the Delegated Sessions feed.
 */
export interface DelegationApproval {
    requestId: string;
    kind: ApprovalRequestKind;
    covered: boolean;
    coverageReason: ApprovalCoverageReason;
    escalated: boolean;
    requestedAt: number;
    /**
     * Opaque version of the request as the delegating Agent reads it. It changes whenever the provider replaces the
     * request under the same ID, and `approve` must echo it so a decision never lands on text the Agent did not read.
     */
    revision: string;
    command?: string;
    cwd?: string;
    paths?: string[];
}

export const delegationApprovalSchema: z.ZodType<DelegationApproval> = z.strictObject({
    ...approvalBase,
    revision: approvalRevisionSchema,
    command: z.string().max(MAX_APPROVAL_COMMAND_CHARS).optional(),
    cwd: z.string().max(MAX_APPROVAL_CWD_CHARS).optional(),
    paths: z
        .array(z.string().max(MAX_APPROVAL_PATH_CHARS))
        .max(MAX_APPROVAL_PATHS_IN_REPLY)
        .optional(),
});

/**
 * What the Delegated Sessions feed shows of a pending approval: its state, never its content.
 */
export type DelegationApprovalSummary = Omit<
    DelegationApproval,
    'command' | 'cwd' | 'paths' | 'revision'
>;

export const delegationApprovalSummarySchema: z.ZodType<DelegationApprovalSummary> =
    z.strictObject(approvalBase);

/**
 * Payload of the transient `agent.delegation.approval` event. Identifiers and a closed state only.
 */
export const delegationApprovalChangedSchema = z.strictObject({
    sessionId: identifierSchema,
    delegationId: identifierSchema,
    requestId: identifierSchema,
    state: z.enum(['pending', 'escalated', 'decided', 'cancelled']),
});
export type DelegationApprovalChanged = z.infer<typeof delegationApprovalChangedSchema>;

export const delegationApproveParametersSchema = z.strictObject({
    delegationId: identifierSchema,
    requestId: identifierSchema,
    decision: approvalDecisionSchema,
    /**
     * The `revision` of the approval the caller read in `wait` or `status`. A mismatch is `CONFLICT` with
     * `details.conflictReason` `request_changed`.
     */
    revision: approvalRevisionSchema,
});

/**
 * `details.conflictReason` of the `CONFLICT` raised when the request changed after the caller read it.
 */
export const APPROVAL_REQUEST_CHANGED = 'request_changed';

/**
 * A refused approval is an error, not an outcome: `FORBIDDEN` carries the `ApprovalCoverageReason` in its `details`.
 */
export const delegationApproveResultSchema = z.strictObject({
    outcome: z.enum(['approved', 'declined']),
});
export type DelegationApproveResult = z.infer<typeof delegationApproveResultSchema>;
