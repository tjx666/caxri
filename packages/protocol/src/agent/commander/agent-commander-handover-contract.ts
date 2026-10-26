import { z } from 'zod';

import { identifierSchema, pathSchema } from '../../domain/identifiers.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { ownerOnlyCommandPolicy } from '../../transport/method-spec.js';
import { delegationProviderSchema } from '../agent-delegation-settings.js';

/**
 * Upper bound on Sessions plus conversations one hand-over request names. Far above a real selection, so one runaway
 * request cannot fill the Commander's ownership record in a single call.
 */
export const MAX_COMMANDER_HANDOVER_BATCH = 100;

/**
 * Upper bound on external conversations one discovery read returns, newest first.
 */
export const MAX_COMMANDER_CONVERSATIONS = 200;

/**
 * Why a handed-over Session gives the Commander ownership only, with no conversation to continue: it has no Agent, its
 * Agent has not reported a conversation yet, or its Agent CLI is not one the Commander can delegate to.
 *
 * `chat_surface` means the Agent runs as a Chat whose provider cannot correlate a Commander task (Grok Build's Chat
 * reports no prompt digest). Hand-overs recorded before the Commander could continue any Agent Chat also carry it.
 */
export const commanderHandoverOwnershipReasons = [
    'agent_missing',
    'chat_surface',
    'provider_session_missing',
    'provider_unsupported',
] as const;
export const commanderHandoverOwnershipReasonSchema = z.enum(commanderHandoverOwnershipReasons);

/**
 * Why one entry of a hand-over request was refused. The rest of the batch is still handed over.
 */
export const commanderHandoverRejections = [
    'session_missing',
    'session_archived',
    'project_unavailable',
    'commander_session',
    'already_managed',
    'commander_unavailable',
    'ownership_capacity',
    'task_capacity',
    'conversation_missing',
    'conversation_bound',
    'duplicate',
] as const;
export const commanderHandoverRejectionSchema = z.enum(commanderHandoverRejections);

/**
 * One Agent conversation, named by the provider that owns it and the provider's own conversation ID (what that
 * provider's resume argument takes).
 */
export const commanderConversationReferenceSchema = z.strictObject({
    provider: delegationProviderSchema,
    providerSessionId: z.string().trim().min(1).max(1_024),
});

/**
 * The conversation a hand-over lets the Commander continue: the Agent Terminal it lives in and its provider identity.
 */
export const commanderHandoverTargetSchema = z.strictObject({
    terminalId: identifierSchema,
    provider: delegationProviderSchema,
    providerSessionId: commanderConversationReferenceSchema.shape.providerSessionId,
});

/**
 * The user's grant of one Session to the Commander. It is not a delegation: it proves only that the user handed the
 * Session over, never that the Commander submitted the conversation's earlier prompts. The Commander's first task in it
 * (`agent delegate create --continue-handover`) creates the real root delegation, after which follow-ups and resumes
 * run as for any Commander task. Taking the Session back, or typing into its Agent, removes the hand-over.
 */
export const commanderHandoverSchema = z.strictObject({
    id: identifierSchema,
    projectId: identifierSchema,
    sessionId: identifierSchema,
    /**
     * `session` hands over an existing Caxri Session; `conversation` imported an Agent conversation started outside
     * Caxri into a new Session.
     */
    source: z.enum(['session', 'conversation']),
    target: commanderHandoverTargetSchema.optional(),
    ownershipReason: commanderHandoverOwnershipReasonSchema.optional(),
    /**
     * The Commander task recorded for the hand-over; the first continuation links its root delegation to it.
     */
    taskId: identifierSchema.optional(),
    /**
     * Set once the Commander's first task consumed the hand-over; later work continues that delegation instead.
     */
    firstDelegationId: identifierSchema.optional(),
    createdAt: z.number().int().positive(),
});

/**
 * One external conversation the user may hand over: an Agent conversation found in a provider's own history that no
 * Caxri Terminal is bound to. `title` is the provider's own title or the first user prompt, shown only in the local
 * UI.
 */
export const commanderConversationSchema = commanderConversationReferenceSchema.extend({
    cwd: pathSchema,
    title: z.string().max(200).optional(),
    updatedAt: z.number(),
    /**
     * Another process may still have the conversation open, for example an Agent CLI in another terminal app. Resuming
     * it in Caxri then forks the conversation, so the UI warns before the user picks it.
     */
    mayBeOpen: z.boolean(),
    /**
     * The visible top-level Project whose root contains `cwd`; null when handing it over adds `cwd` as a new Project.
     */
    projectId: identifierSchema.nullable(),
});

const handoverOutcomeSchema = z.discriminatedUnion('outcome', [
    z.strictObject({
        outcome: z.literal('accepted'),
        sessionId: identifierSchema,
        handoverId: identifierSchema,
        taskId: identifierSchema.optional(),
        ownershipReason: commanderHandoverOwnershipReasonSchema.optional(),
        conversation: commanderConversationReferenceSchema.optional(),
    }),
    z.strictObject({
        outcome: z.literal('rejected'),
        reason: commanderHandoverRejectionSchema,
        sessionId: identifierSchema.optional(),
        conversation: commanderConversationReferenceSchema.optional(),
    }),
]);

export const commanderHandoverRequestSchema = z
    .strictObject({
        sessionIds: z.array(identifierSchema).max(MAX_COMMANDER_HANDOVER_BATCH).default([]),
        conversations: z
            .array(commanderConversationReferenceSchema)
            .max(MAX_COMMANDER_HANDOVER_BATCH)
            .default([]),
        /**
         * What the user wants done, recorded as the Commander task's note. Never part of a notice line or a log.
         */
        note: z.string().trim().max(2_000).optional(),
    })
    .refine(
        (value) => value.sessionIds.length + value.conversations.length > 0,
        'Name at least one Session or conversation',
    )
    .refine(
        (value) =>
            value.sessionIds.length + value.conversations.length <= MAX_COMMANDER_HANDOVER_BATCH,
        `Hand over at most ${MAX_COMMANDER_HANDOVER_BATCH} at once`,
    );

export const commanderHandoverResultSchema = z.strictObject({
    outcomes: z.array(handoverOutcomeSchema).max(MAX_COMMANDER_HANDOVER_BATCH),
});

/**
 * How many recent human-input take-backs `commander.managedSessions` reports. Far above how many a user can cause
 * between two reads, so a reader that refreshes on `state.changed` never misses one.
 */
export const MAX_COMMANDER_INPUT_TAKE_BACKS = 16;

const commanderInputTakeBackSchema = z.strictObject({
    id: z.string().min(1).max(64),
    sessionId: identifierSchema,
    at: z.number(),
});

/**
 * The Workbench's view of Commander ownership.
 *
 * `inputTakeBacks` reports the take-backs typing caused, so the Workbench can say that a keystroke just ended the
 * Commander's management. It rides on this read rather than on its own Server event on purpose: every take-back already
 * announces a full `state.changed`, after which the Workbench must re-read this set anyway to update the Session row
 * marker, so the notice arrives with the same read and needs no second event in the registry, the durable journal, the
 * mobile subscriptions, and the companion-window policy. The list lives in Server Core's memory only: a notice is worth
 * showing while it is fresh, and a reader that starts later treats every entry it first sees as already shown.
 */
export const commanderManagedSessionsSchema = z.strictObject({
    sessionIds: z.array(identifierSchema).max(1_000),
    /**
     * The Commander's own hidden Session, so the Workbench can name the Commander as the creator of a Session whose
     * `createdBySessionId` points there. Absent while no Commander exists.
     */
    commanderSessionId: identifierSchema.optional(),
    /**
     * The subset of `sessionIds` whose hand-over continues an Agent conversation, where typing into that Agent takes
     * the Session back. Sessions the Commander created, and ownership-only hand-overs, are not in it.
     */
    inputTakeBackSessionIds: z.array(identifierSchema).max(1_000),
    /**
     * The subset of `inputTakeBackSessionIds` whose Agent runs as a Chat. Typing a draft there takes nothing back; only
     * sending (a message, command, rewind, Send Now, or queue Resume) or stopping does, so the Workbench words it so.
     */
    chatTakeBackSessionIds: z.array(identifierSchema).max(1_000).default([]),
    /**
     * The most recent take-backs caused by the user typing into a handed-over Agent, oldest first. `id` stays unique
     * across Server Core restarts, `at` is the take-back time.
     */
    inputTakeBacks: z.array(commanderInputTakeBackSchema).max(MAX_COMMANDER_INPUT_TAKE_BACKS),
});

export type CommanderHandover = z.infer<typeof commanderHandoverSchema>;
export type CommanderManagedSessions = z.infer<typeof commanderManagedSessionsSchema>;
export type CommanderInputTakeBack = z.infer<typeof commanderInputTakeBackSchema>;
export type CommanderHandoverTarget = z.infer<typeof commanderHandoverTargetSchema>;
export type CommanderHandoverOwnershipReason = z.infer<
    typeof commanderHandoverOwnershipReasonSchema
>;
export type CommanderHandoverRejection = z.infer<typeof commanderHandoverRejectionSchema>;
export type CommanderHandoverOutcome = z.infer<typeof handoverOutcomeSchema>;
export type CommanderHandoverRequest = z.input<typeof commanderHandoverRequestSchema>;
export type CommanderHandoverResult = z.infer<typeof commanderHandoverResultSchema>;
export type CommanderConversation = z.infer<typeof commanderConversationSchema>;
export type CommanderConversationReference = z.infer<typeof commanderConversationReferenceSchema>;

/**
 * Hand-over requests are the user's, never an Agent's. `agents.control` alone is not enough: an `agent:control` grant
 * also gives it to an Agent Endpoint, so these methods declare `principal: 'owner'` and Server Core refuses them for
 * every principal other than the Desktop and the human CLI. The Commander can never take a Session the user did not
 * give it.
 */
export const commanderHandoverMethods = {
    /**
     * Hands Sessions, or Agent conversations started outside Caxri, to the Commander. Each entry succeeds or is refused
     * on its own; a conversation is imported into a new Session first, adding its folder as a Project when no visible
     * Project contains it.
     */
    'commander.session.handOver': {
        ...ownerOnlyCommandPolicy('server', 'control', ['agents.control']),
        params: commanderHandoverRequestSchema,
        result: commanderHandoverResultSchema,
    },
    /**
     * Removes one Session from the Commander's management, with its hand-over. The Session and its Agents keep running;
     * the Commander only loses the right to start or continue work there.
     */
    'commander.session.takeBack': {
        ...ownerOnlyCommandPolicy('server', 'control', ['agents.control']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: z.strictObject({
            sessionId: identifierSchema,
            outcome: z.enum(['taken_back', 'not_managed']),
        }),
    },
    /**
     * The Sessions the Commander manages, for the Workbench's Commander marker and menu, with the recent take-backs
     * typing caused. IDs and timestamps only. Owner-only: it spans every Project and has no Agent consumer.
     */
    'commander.managedSessions': {
        ...ownerOnlyCommandPolicy('server', 'read', ['agents.read']),
        params: z.object({}).default({}),
        result: commanderManagedSessionsSchema,
    },
    /**
     * Agent conversations found in the providers' own history that no Caxri Terminal is bound to, newest first.
     */
    'commander.conversations': {
        ...ownerOnlyCommandPolicy('server', 'read', ['agents.control']),
        params: z.object({}).default({}),
        result: z.strictObject({
            conversations: z.array(commanderConversationSchema).max(MAX_COMMANDER_CONVERSATIONS),
        }),
    },
} as const satisfies Record<string, MethodSpec>;
