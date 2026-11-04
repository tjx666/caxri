import { z } from 'zod';

import { identifierSchema } from '../../../domain/identifiers.js';
import type { MethodSpec } from '../../../transport/method-spec.js';
import { commandPolicy } from '../../../transport/method-spec.js';
import { principalSchema } from '../../../transport/principal.js';
import {
    agentDelegationFailureSchema,
    delegationEffortSchema,
    delegationModelSchema,
} from '../agent-delegation-settings.js';
import { agentDelegationUsageSchema } from '../agent-delegation-usage.js';

/**
 * Most entries one `agent.delegation.history` page returns.
 */
export const MAX_DELEGATION_HISTORY_PAGE = 50;

/**
 * Longest `query`, in characters after trimming.
 */
export const MAX_DELEGATION_HISTORY_QUERY = 100;

/**
 * The statuses a task can settle in, the only ones a history entry carries. Active statuses (including `blocked`) are
 * excluded on purpose: history lists finished work.
 */
export const delegationHistoryOutcomeSchema = z.enum([
    'completed',
    'human_intervened',
    'interrupted',
    'failed',
    'answer_unavailable',
]);
export type DelegationHistoryOutcome = z.infer<typeof delegationHistoryOutcomeSchema>;

const hasNoControlCharacters = (value: string): boolean =>
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point.
    !/[\u{0}-\u{1F}\u{7F}]/u.test(value);

const historyParameters = z.strictObject({
    /**
     * Text to find in a task's Session title or stored summary (case-insensitive, literal; `%` and `_` match
     * themselves). Never matched against prompts or answers.
     */
    query: z
        .string()
        .trim()
        .min(1)
        .max(MAX_DELEGATION_HISTORY_QUERY)
        .refine(hasNoControlCharacters)
        .optional(),
    outcome: delegationHistoryOutcomeSchema.optional(),
    limit: z.number().int().min(1).max(MAX_DELEGATION_HISTORY_PAGE).default(20),
    /**
     * The `nextCursor` of the previous page. Opaque; bound to the query, outcome filter, and caller of that page.
     */
    after: z.string().min(1).max(512).optional(),
});

const historyEntrySchema = z.strictObject({
    delegationId: identifierSchema,
    rootDelegationId: identifierSchema,
    retryOf: identifierSchema.optional(),
    sessionId: identifierSchema,
    outcome: delegationHistoryOutcomeSchema,
    failure: agentDelegationFailureSchema.optional(),
    provider: z.string().min(1).max(100),
    selection: z
        .strictObject({
            model: delegationModelSchema.optional(),
            effort: delegationEffortSchema.optional(),
        })
        .optional(),
    /**
     * The Session title when the task settled, clipped to 200 characters. It can echo the first words of a prompt.
     * Absent once compacted or when the Session was gone at settle time.
     */
    title: z.string().max(200).optional(),
    /**
     * The delegated Agent's bounded summary (at most 280 characters), only for a completed task. Its source says
     * whether the Agent authored it or Caxri took the answer's first paragraph, which can hold answer text.
     */
    summary: z.string().max(280).optional(),
    summarySource: z.enum(['authored', 'excerpt']).optional(),
    createdAt: z.number().int().positive(),
    settledAt: z.number().int().positive(),
    /**
     * Provider token counters, never a price. Counters the provider did not report are absent, never zero.
     */
    usage: agentDelegationUsageSchema.omit({ source: true }).optional(),
    /**
     * True once the 5000-entry searchable window moved past this entry: its title and summary were dropped, but its
     * identifiers, outcome, and counters remain.
     */
    compacted: z.boolean(),
});
export type DelegationHistoryEntry = z.infer<typeof historyEntrySchema>;

const historyResultSchema = z.strictObject({
    entries: z.array(historyEntrySchema).max(MAX_DELEGATION_HISTORY_PAGE),
    nextCursor: z.string().min(1).max(512).optional(),
    hasMore: z.boolean(),
});

/**
 * Named interfaces rather than inferred aliases, like `AgentDelegationReceipt`: the method registry's inferred type is
 * at the compiler's serialization limit, so these methods are annotated with them instead of letting the compiler
 * expand their schemas into the registry.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the name is the point.
export interface DelegationHistoryResult extends z.infer<typeof historyResultSchema> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the name is the point.
interface DelegationHistoryParameters extends z.output<typeof historyParameters> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the name is the point.
interface DelegationHistoryRequest extends z.input<typeof historyParameters> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the name is the point.
interface DelegationHistoryAuthorityRequest extends z.input<typeof internalParameters> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the name is the point.
interface DelegationHistoryAuthorityParameters extends z.output<typeof internalParameters> {}

/**
 * `agent.delegation.history` as a named type; exported so the registry's declaration can name it.
 *
 * @public
 */
export interface AgentDelegationHistorySpec extends ReturnType<
    typeof commandPolicy<'server', 'read'>
> {
    params: z.ZodType<DelegationHistoryParameters, DelegationHistoryRequest>;
    result: z.ZodType<DelegationHistoryResult>;
}

/**
 * `agent.delegation.historyInternal` as a named type; exported so the registry's declaration can name it.
 *
 * @public
 */
export interface AgentDelegationHistoryInternalSpec extends ReturnType<
    typeof commandPolicy<'server', 'read'>
> {
    params: z.ZodType<DelegationHistoryAuthorityParameters, DelegationHistoryAuthorityRequest>;
    result: z.ZodType<DelegationHistoryResult>;
}

const authoritySchema = z.strictObject({
    principal: principalSchema,
    callerTerminalId: identifierSchema.optional(),
});
const internalParameters = authoritySchema.extend(historyParameters.shape);

/**
 * The public half. Registered in the public method map only; the Internal twin below is a separate map so no Client
 * request can reach an authority-carrying method.
 */
export const agentDelegationHistoryMethods = {
    /**
     * The caller's own settled tasks, newest first, with an optional text search over title and summary. An Agent sees
     * only tasks its exact Endpoint generation created; the owner sees every task. Never claims an answer.
     */
    'agent.delegation.history': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: historyParameters,
        result: historyResultSchema,
    } satisfies AgentDelegationHistorySpec as AgentDelegationHistorySpec,
} as const satisfies Record<string, MethodSpec>;

export const agentDelegationHistoryInternalMethods = {
    'agent.delegation.historyInternal': {
        ...commandPolicy('server', 'read'),
        params: internalParameters,
        result: historyResultSchema,
    } satisfies AgentDelegationHistoryInternalSpec as AgentDelegationHistoryInternalSpec,
} as const satisfies Record<string, MethodSpec>;
