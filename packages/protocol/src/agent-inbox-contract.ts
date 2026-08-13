import { z } from 'zod';

import { agentEndpointRefSchema, agentEndpointSummarySchema } from './agent-endpoint-contract.js';
import { identifierSchema } from './domain.js';
import { commandPolicy, type MethodSpec } from './method-spec.js';

export const MAX_AGENT_MESSAGE_BYTES = 16 * 1024;
export const AGENT_MESSAGE_APPROVAL_TTL_MS = 5 * 60 * 1_000;

function containsProtocolControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
    }
    return false;
}

/** Peer Inbox V1 is text-only: it cannot encode commands, attachments, or opaque task payloads. */
export const agentMessageBodySchema = z
    .string()
    .min(1)
    .refine(
        (value) => new TextEncoder().encode(value).byteLength <= MAX_AGENT_MESSAGE_BYTES,
        `Message body exceeds ${MAX_AGENT_MESSAGE_BYTES} UTF-8 bytes`,
    )
    .refine(
        (value) => !containsProtocolControlCharacter(value),
        'Message body contains protocol control characters',
    );

export const agentMessageStatusSchema = z.enum([
    'waiting',
    'held',
    'delivered',
    'refused',
    'expired',
    'unavailable',
    'capacity',
]);

export const agentInboundPolicySchema = z.enum(['auto', 'accept', 'hold', 'refuse']);
export const agentHeldRetentionSchema = z.enum(['approval-window', 'endpoint']);

export const agentMessageReceiptSchema = z
    .object({
        messageId: identifierSchema,
        from: agentEndpointRefSchema,
        to: agentEndpointRefSchema,
        status: agentMessageStatusSchema,
        createdAt: z.number().int().positive(),
        updatedAt: z.number().int().positive(),
        expiresAt: z.number().int().positive(),
        replyTo: identifierSchema.optional(),
    })
    .strict();

export const agentInboundMessageSchema = z
    .object({
        id: identifierSchema,
        origin: z.literal('peer'),
        from: agentEndpointSummarySchema,
        to: agentEndpointRefSchema,
        body: agentMessageBodySchema,
        createdAt: z.number().int().positive(),
        expiresAt: z.number().int().positive(),
        replyTo: identifierSchema.optional(),
    })
    .strict();

export const agentHeldMessageSchema = z
    .object({
        messageId: identifierSchema,
        from: agentEndpointSummarySchema,
        to: agentEndpointRefSchema,
        preview: z.string().max(240),
        byteLength: z.number().int().positive().max(MAX_AGENT_MESSAGE_BYTES),
        createdAt: z.number().int().positive(),
        expiresAt: z.number().int().positive(),
        replyTo: identifierSchema.optional(),
    })
    .strict();

export const agentInboundPolicyResultSchema = z
    .object({
        policy: agentInboundPolicySchema,
        heldRetention: agentHeldRetentionSchema,
    })
    .strict();

export const agentMessagePullResultSchema = z
    .object({
        message: agentInboundMessageSchema.nullable(),
        outcome: z.enum(['message', 'empty', 'timed_out']),
    })
    .strict();

const sendParamsSchema = z
    .object({
        to: agentEndpointRefSchema,
        body: agentMessageBodySchema,
        idempotencyKey: identifierSchema.optional(),
        ttlMs: z.number().int().min(1_000).max(3_600_000).default(AGENT_MESSAGE_APPROVAL_TTL_MS),
    })
    .strict();

const desktopMessageTargetSchema = z.object({ messageId: identifierSchema }).strict();

export const agentInboxMethods = {
    'agent.message.send': {
        ...commandPolicy('host', 'write', ['agents.message']),
        params: sendParamsSchema,
        result: agentMessageReceiptSchema,
    },
    'agent.message.reply': {
        ...commandPolicy('host', 'write', ['agents.message']),
        params: sendParamsSchema.extend({ replyTo: identifierSchema }),
        result: agentMessageReceiptSchema,
    },
    /** A pull consumes only after the Host confirms that its UDS reply was flushed. */
    'agent.message.wait': {
        ...commandPolicy('host', 'read', ['agents.message']),
        params: z
            .object({ timeoutMs: z.number().int().min(100).max(120_000).default(15_000) })
            .strict(),
        result: agentMessagePullResultSchema,
    },
    'agent.message.check': {
        ...commandPolicy('host', 'read', ['agents.message']),
        params: z.object({}).strict().default({}),
        result: agentMessagePullResultSchema,
    },
    'agent.message.receipt': {
        ...commandPolicy('host', 'read', ['agents.message']),
        params: z.object({ messageId: identifierSchema }).strict(),
        result: agentMessageReceiptSchema,
    },
    'agent.message.policy.get': {
        ...commandPolicy('host', 'read', ['agents.message']),
        params: z.object({}).strict().default({}),
        result: agentInboundPolicyResultSchema,
    },
    'agent.message.policy.set': {
        ...commandPolicy('host', 'write', ['agents.message']),
        params: agentInboundPolicyResultSchema,
        result: agentInboundPolicyResultSchema,
    },
    'agent.message.held': {
        ...commandPolicy('host', 'read', ['desktop']),
        params: z.object({}).strict().default({}),
        result: z.object({ messages: z.array(agentHeldMessageSchema).max(1_024) }).strict(),
    },
    'agent.message.approve': {
        ...commandPolicy('host', 'write', ['desktop']),
        params: desktopMessageTargetSchema,
        result: agentMessageReceiptSchema,
    },
    'agent.message.deny': {
        ...commandPolicy('host', 'write', ['desktop']),
        params: desktopMessageTargetSchema,
        result: agentMessageReceiptSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type AgentMessageReceipt = z.infer<typeof agentMessageReceiptSchema>;
export type AgentInboundMessage = z.infer<typeof agentInboundMessageSchema>;
export type AgentHeldMessage = z.infer<typeof agentHeldMessageSchema>;
export type AgentInboundPolicy = z.infer<typeof agentInboundPolicySchema>;
export type AgentHeldRetention = z.infer<typeof agentHeldRetentionSchema>;
export type AgentMessagePullResult = z.infer<typeof agentMessagePullResultSchema>;
