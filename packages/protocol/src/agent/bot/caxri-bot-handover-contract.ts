import { z } from 'zod';

import { identifierSchema, pathSchema } from '../../domain/identifiers.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { ownerOnlyCommandPolicy } from '../../transport/method-spec.js';
import { delegationProviderSchema } from '../delegation/agent-delegation-settings.js';

/**
 * Upper bound on Sessions plus conversations one hand-over request names. Far above a real selection, so one runaway
 * request cannot fill Caxri Bot's ownership record in a single call.
 */
export const MAX_BOT_HANDOVER_BATCH = 100;

/**
 * Upper bound on external conversations one discovery read returns, newest first.
 */
export const MAX_BOT_CONVERSATIONS = 200;

/**
 * Why a handed-over Session gives Caxri Bot ownership only, with no conversation to continue: it has no Agent, its
 * Agent has not reported a conversation yet, or its Agent CLI is not one Caxri Bot can delegate to.
 *
 * `chat_surface` means the Agent runs as a Chat whose provider cannot correlate a Caxri Bot task (Grok Build's Chat
 * reports no prompt digest). Hand-overs recorded before Caxri Bot could continue any Agent Chat also carry it.
 */
const botHandoverOwnershipReasons = [
    'agent_missing',
    'chat_surface',
    'provider_session_missing',
    'provider_unsupported',
] as const;
export const botHandoverOwnershipReasonSchema = z.enum(botHandoverOwnershipReasons);

/**
 * Why one entry of a hand-over request was refused. The rest of the batch is still handed over.
 */
const botHandoverRejections = [
    'session_missing',
    'session_archived',
    'project_unavailable',
    'bot_session',
    'already_managed',
    'bot_unavailable',
    'ownership_capacity',
    'task_capacity',
    'conversation_missing',
    'conversation_bound',
    'duplicate',
] as const;
export const botHandoverRejectionSchema = z.enum(botHandoverRejections);

/**
 * One Agent conversation, named by the provider that owns it and the provider's own conversation ID (what that
 * provider's resume argument takes).
 */
const botConversationReferenceSchema = z.strictObject({
    provider: delegationProviderSchema,
    providerSessionId: z.string().trim().min(1).max(1_024),
});

/**
 * The conversation a hand-over lets Caxri Bot continue: the Agent Terminal it lives in and its provider identity.
 */
const botHandoverTargetSchema = z.strictObject({
    terminalId: identifierSchema,
    provider: delegationProviderSchema,
    providerSessionId: botConversationReferenceSchema.shape.providerSessionId,
});

/**
 * The user's grant of one Session to Caxri Bot. It is not a delegation: it proves only that the user handed the Session
 * over, never that Caxri Bot submitted the conversation's earlier prompts. Caxri Bot's first task in it (`agent
 * delegate create --continue-handover`) creates the real root delegation, after which follow-ups and resumes run as for
 * any Caxri Bot task. Taking the Session back, or typing into its Agent, removes the hand-over.
 */
export const botHandoverSchema = z.strictObject({
    id: identifierSchema,
    projectId: identifierSchema,
    sessionId: identifierSchema,
    /**
     * `session` hands over an existing Caxri Session; `conversation` imported an Agent conversation started outside
     * Caxri into a new Session.
     */
    source: z.enum(['session', 'conversation']),
    target: botHandoverTargetSchema.optional(),
    ownershipReason: botHandoverOwnershipReasonSchema.optional(),
    /**
     * Caxri Bot task recorded for the hand-over; the first continuation links its root delegation to it.
     */
    taskId: identifierSchema.optional(),
    /**
     * Set once Caxri Bot's first task consumed the hand-over; later work continues that delegation instead.
     */
    firstDelegationId: identifierSchema.optional(),
    createdAt: z.number().int().positive(),
});

/**
 * One external conversation the user may hand over: an Agent conversation found in a provider's own history that no
 * Caxri Terminal is bound to. `title` is the provider's own title or the first user prompt, shown only in the local
 * UI.
 */
const botConversationSchema = botConversationReferenceSchema.extend({
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
        ownershipReason: botHandoverOwnershipReasonSchema.optional(),
        conversation: botConversationReferenceSchema.optional(),
    }),
    z.strictObject({
        outcome: z.literal('rejected'),
        reason: botHandoverRejectionSchema,
        sessionId: identifierSchema.optional(),
        conversation: botConversationReferenceSchema.optional(),
    }),
]);

export const botHandoverRequestSchema = z
    .strictObject({
        sessionIds: z.array(identifierSchema).max(MAX_BOT_HANDOVER_BATCH).default([]),
        conversations: z
            .array(botConversationReferenceSchema)
            .max(MAX_BOT_HANDOVER_BATCH)
            .default([]),
        /**
         * What the user wants done, recorded as Caxri Bot task's note. Never part of a notice line or a log.
         */
        note: z.string().trim().max(2_000).optional(),
    })
    .refine(
        (value) => value.sessionIds.length + value.conversations.length > 0,
        'Name at least one Session or conversation',
    )
    .refine(
        (value) => value.sessionIds.length + value.conversations.length <= MAX_BOT_HANDOVER_BATCH,
        `Hand over at most ${MAX_BOT_HANDOVER_BATCH} at once`,
    );

const botHandoverResultSchema = z.strictObject({
    outcomes: z.array(handoverOutcomeSchema).max(MAX_BOT_HANDOVER_BATCH),
});

/**
 * How many recent human-input take-backs `bot.managedSessions` reports. Far above how many a user can cause between two
 * reads, so a reader that refreshes on `state.changed` never misses one.
 */
export const MAX_BOT_INPUT_TAKE_BACKS = 16;

const botInputTakeBackSchema = z.strictObject({
    id: z.string().min(1).max(64),
    sessionId: identifierSchema,
    at: z.number(),
});

/**
 * The Workbench's view of Caxri Bot ownership.
 *
 * `inputTakeBacks` reports the take-backs typing caused, so the Workbench can say that a keystroke just ended the Caxri
 * Bot's management. It rides on this read rather than on its own Server event on purpose: every take-back already
 * announces a full `state.changed`, after which the Workbench must re-read this set anyway to update the Session row
 * marker, so the notice arrives with the same read and needs no second event in the registry, the durable journal, the
 * mobile subscriptions, and the companion-window policy. The list lives in Server Core's memory only: a notice is worth
 * showing while it is fresh, and a reader that starts later treats every entry it first sees as already shown.
 */
const botManagedSessionsSchema = z.strictObject({
    sessionIds: z.array(identifierSchema).max(1_000),
    /**
     * Caxri Bot's own hidden Session, so the Workbench can name Caxri Bot as the creator of a Session whose
     * `createdBySessionId` points there. Absent while no Caxri Bot exists.
     */
    botSessionId: identifierSchema.optional(),
    /**
     * The subset of `sessionIds` whose hand-over continues an Agent conversation, where typing into that Agent takes
     * the Session back. Sessions Caxri Bot created, and ownership-only hand-overs, are not in it.
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
    inputTakeBacks: z.array(botInputTakeBackSchema).max(MAX_BOT_INPUT_TAKE_BACKS),
});

export type BotHandover = z.infer<typeof botHandoverSchema>;
export type BotManagedSessions = z.infer<typeof botManagedSessionsSchema>;
export type BotInputTakeBack = z.infer<typeof botInputTakeBackSchema>;
export type BotHandoverTarget = z.infer<typeof botHandoverTargetSchema>;
export type BotHandoverOwnershipReason = z.infer<typeof botHandoverOwnershipReasonSchema>;
export type BotHandoverRejection = z.infer<typeof botHandoverRejectionSchema>;
export type BotHandoverOutcome = z.infer<typeof handoverOutcomeSchema>;
export type BotHandoverRequest = z.input<typeof botHandoverRequestSchema>;
export type BotHandoverResult = z.infer<typeof botHandoverResultSchema>;
export type BotConversation = z.infer<typeof botConversationSchema>;
export type BotConversationReference = z.infer<typeof botConversationReferenceSchema>;

/**
 * Hand-over requests are the user's, never an Agent's. `agents.control` alone is not enough: an `agent:control` grant
 * also gives it to an Agent Endpoint, so these methods declare `principal: 'owner'` and Server Core refuses them for
 * every principal other than the Desktop and the human CLI. Caxri Bot can never take a Session the user did not give
 * it.
 */
export const botHandoverMethods = {
    /**
     * Hands Sessions, or Agent conversations started outside Caxri, to Caxri Bot. Each entry succeeds or is refused on
     * its own; a conversation is imported into a new Session first, adding its folder as a Project when no visible
     * Project contains it.
     */
    'bot.session.handOver': {
        ...ownerOnlyCommandPolicy('server', 'control', ['agents.control']),
        params: botHandoverRequestSchema,
        result: botHandoverResultSchema,
    },
    /**
     * Removes one Session from Caxri Bot's management, with its hand-over. The Session and its Agents keep running;
     * Caxri Bot only loses the right to start or continue work there.
     */
    'bot.session.takeBack': {
        ...ownerOnlyCommandPolicy('server', 'control', ['agents.control']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: z.strictObject({
            sessionId: identifierSchema,
            outcome: z.enum(['taken_back', 'not_managed']),
        }),
    },
    /**
     * The Sessions Caxri Bot manages, for the Workbench's Caxri Bot marker and menu, with the recent take-backs typing
     * caused. IDs and timestamps only. Owner-only: it spans every Project and has no Agent consumer.
     */
    'bot.managedSessions': {
        ...ownerOnlyCommandPolicy('server', 'read', ['agents.read']),
        params: z.object({}).default({}),
        result: botManagedSessionsSchema,
    },
    /**
     * Agent conversations found in the providers' own history that no Caxri Terminal is bound to, newest first.
     */
    'bot.conversations': {
        ...ownerOnlyCommandPolicy('server', 'read', ['agents.control']),
        params: z.object({}).default({}),
        result: z.strictObject({
            conversations: z.array(botConversationSchema).max(MAX_BOT_CONVERSATIONS),
        }),
    },
} as const satisfies Record<string, MethodSpec>;
