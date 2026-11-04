import { z } from 'zod';

import { identifierSchema } from '../../domain/identifiers.js';

/**
 * Longest question a delegated Agent asks, in characters.
 */
export const MAX_QUESTION_TEXT_CHARS = 2000;

/**
 * Most answer choices one question offers.
 */
export const MAX_QUESTION_OPTIONS = 6;

/**
 * Longest single answer choice, in characters.
 */
export const MAX_QUESTION_OPTION_CHARS = 120;

/**
 * Longest answer to a question, in characters.
 */
export const MAX_ANSWER_TEXT_CHARS = 4000;

/**
 * Most questions one delegation ever stores, answered or not. Bounds the private rows a long-lived delegation
 * accumulates; the next `ask` after the cap is refused with `CAPACITY`.
 */
export const MAX_QUESTIONS_PER_DELEGATION = 10;

/**
 * How long an open question waits for the delegating Agent before the Session shows it to the user, in milliseconds.
 */
export const QUESTION_ESCALATION_GRACE_MS = 600_000;

/**
 * Longest single `agent.delegation.askWait` long poll.
 */
export const MAX_QUESTION_WAIT_TIMEOUT_MS = 300_000;

/**
 * Most open questions one `agent.delegation.questions` read returns.
 */
export const MAX_LISTED_QUESTIONS = 64;

export const delegationQuestionStateSchema = z.enum(['open', 'answered', 'cancelled']);
export type DelegationQuestionState = z.infer<typeof delegationQuestionStateSchema>;

/**
 * Who answered: the delegating Agent (`parent`) or the user from the Session (`user`).
 */
export const delegationQuestionAnsweredBySchema = z.enum(['parent', 'user']);
export type DelegationQuestionAnsweredBy = z.infer<typeof delegationQuestionAnsweredBySchema>;

/**
 * Why an open question closed without an answer:
 *
 * - `child_cancelled`: the asking Agent withdrew it.
 * - `taken_over`: the user typed into the asking Session, so the question is moot.
 * - `host_reset`: Server Core restarted; the asking Agent's wait is gone.
 * - `task_ended`: the task settled, stopped, or failed.
 */
export const delegationQuestionCancelReasonSchema = z.enum([
    'child_cancelled',
    'taken_over',
    'host_reset',
    'task_ended',
]);
export type DelegationQuestionCancelReason = z.infer<typeof delegationQuestionCancelReasonSchema>;

/**
 * Why an open question became the user's to answer: the grace period elapsed, or the delegating Agent's original launch
 * is gone (retired, or its Terminal deleted).
 */
export const delegationQuestionEscalationReasonSchema = z.enum(['grace_elapsed', 'parent_gone']);
export type DelegationQuestionEscalationReason = z.infer<
    typeof delegationQuestionEscalationReasonSchema
>;

const questionIdSchema = identifierSchema;
const optionSchema = z.string().trim().min(1).max(MAX_QUESTION_OPTION_CHARS);

export const delegationQuestionAskParametersSchema = z.strictObject({
    text: z.string().trim().min(1).max(MAX_QUESTION_TEXT_CHARS),
    options: z.array(optionSchema).max(MAX_QUESTION_OPTIONS).optional(),
    /**
     * Makes a retried `ask` idempotent: the same ID returns the original question whatever its state.
     */
    requestId: identifierSchema.optional(),
});

/**
 * `asked` is a new or replayed question; `already_open` means a different question of this delegation is still open and
 * was left as it is.
 */
export interface DelegationQuestionAskResult {
    outcome: 'asked' | 'already_open';
    questionId: string;
    askedAt: number;
}

export const delegationQuestionAskResultSchema: z.ZodType<DelegationQuestionAskResult> =
    z.strictObject({
        outcome: z.enum(['asked', 'already_open']),
        questionId: questionIdSchema,
        askedAt: z.number().int().positive(),
    });

export const delegationQuestionWaitParametersSchema = z.strictObject({
    questionId: questionIdSchema,
    timeoutMs: z.number().int().min(0).max(MAX_QUESTION_WAIT_TIMEOUT_MS).default(30_000),
});

/**
 * A `timeout` means the question is still open: wait again, never ask it again.
 */
export interface DelegationQuestionWaitResult {
    outcome: 'answered' | 'cancelled' | 'timeout';
    answer?: string;
    answeredBy?: DelegationQuestionAnsweredBy;
    cancelReason?: DelegationQuestionCancelReason;
}

export const delegationQuestionWaitResultSchema: z.ZodType<DelegationQuestionWaitResult> =
    z.strictObject({
        outcome: z.enum(['answered', 'cancelled', 'timeout']),
        answer: z.string().max(MAX_ANSWER_TEXT_CHARS).optional(),
        answeredBy: delegationQuestionAnsweredBySchema.optional(),
        cancelReason: delegationQuestionCancelReasonSchema.optional(),
    });

export const delegationQuestionCancelParametersSchema = z.strictObject({
    questionId: questionIdSchema,
});

export interface DelegationQuestionCancelResult {
    outcome: 'cancelled' | 'already_closed';
}

export const delegationQuestionCancelResultSchema: z.ZodType<DelegationQuestionCancelResult> =
    z.strictObject({ outcome: z.enum(['cancelled', 'already_closed']) });

export const delegationQuestionsParametersSchema = z.strictObject({
    delegationId: identifierSchema.optional(),
});

/**
 * One open question as the delegating Agent reads it.
 */
export interface DelegationQuestionEntry {
    delegationId: string;
    sessionId: string;
    questionId: string;
    text: string;
    options?: string[];
    askedAt: number;
    escalated: boolean;
}

const delegationQuestionEntrySchema: z.ZodType<DelegationQuestionEntry> = z.strictObject({
    delegationId: identifierSchema,
    sessionId: identifierSchema,
    questionId: questionIdSchema,
    text: z.string().max(MAX_QUESTION_TEXT_CHARS),
    options: z
        .array(z.string().max(MAX_QUESTION_OPTION_CHARS))
        .max(MAX_QUESTION_OPTIONS)
        .optional(),
    askedAt: z.number().int().positive(),
    escalated: z.boolean(),
});

export interface DelegationQuestionsResult {
    questions: DelegationQuestionEntry[];
}

export const delegationQuestionsResultSchema: z.ZodType<DelegationQuestionsResult> = z.strictObject(
    { questions: z.array(delegationQuestionEntrySchema).max(MAX_LISTED_QUESTIONS) },
);

export const delegationQuestionAnswerParametersSchema = z.strictObject({
    delegationId: identifierSchema,
    questionId: questionIdSchema,
    text: z.string().trim().min(1).max(MAX_ANSWER_TEXT_CHARS),
});

/**
 * `already_answered` and `cancelled` mean the question closed first; the answer sent now was not delivered.
 */
export interface DelegationQuestionAnswerResult {
    outcome: 'answered' | 'already_answered' | 'cancelled';
}

export const delegationQuestionAnswerResultSchema: z.ZodType<DelegationQuestionAnswerResult> =
    z.strictObject({ outcome: z.enum(['answered', 'already_answered', 'cancelled']) });

export const delegationQuestionDetailParametersSchema = z.strictObject({
    delegationId: identifierSchema,
});

/**
 * The open question of one delegation, for the owner's Session view. Text is private: only this owner-only read and the
 * delegating Agent's `questions` carry it.
 */
export interface DelegationQuestionDetail {
    questionId: string;
    text: string;
    options?: string[];
    askedAt: number;
    escalated: boolean;
}

export interface DelegationQuestionDetailResult {
    question?: DelegationQuestionDetail;
}

const delegationQuestionDetailSchema: z.ZodType<DelegationQuestionDetail> = z.strictObject({
    questionId: questionIdSchema,
    text: z.string().max(MAX_QUESTION_TEXT_CHARS),
    options: z
        .array(z.string().max(MAX_QUESTION_OPTION_CHARS))
        .max(MAX_QUESTION_OPTIONS)
        .optional(),
    askedAt: z.number().int().positive(),
    escalated: z.boolean(),
});

export const delegationQuestionDetailResultSchema: z.ZodType<DelegationQuestionDetailResult> =
    z.strictObject({ question: delegationQuestionDetailSchema.optional() });

/**
 * What the Delegated Sessions feed shows of an open question: no text, so a Client that only draws a state never holds
 * the question.
 */
export interface DelegationQuestionSummary {
    questionId: string;
    askedAt: number;
    escalated: boolean;
}

export const delegationQuestionSummarySchema: z.ZodType<DelegationQuestionSummary> = z.strictObject(
    {
        questionId: questionIdSchema,
        askedAt: z.number().int().positive(),
        escalated: z.boolean(),
    },
);

/**
 * Who a Session's open question waits on: the delegating Agent, or the user once it escalated.
 */
export const delegationWaitingOnSchema = z.enum(['parent', 'user']);
export type DelegationWaitingOn = z.infer<typeof delegationWaitingOnSchema>;

/**
 * Payload of the transient `agent.delegation.questionChanged` event. Identifiers and closed values only: never the
 * question or answer text, never logged.
 */
export const delegationQuestionChangedSchema = z.strictObject({
    sessionId: identifierSchema,
    delegationId: identifierSchema,
    questionId: questionIdSchema,
    state: delegationQuestionStateSchema,
    escalated: z.boolean(),
});
export type DelegationQuestionChanged = z.infer<typeof delegationQuestionChangedSchema>;
