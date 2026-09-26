import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';

const attentionOptionSchema = z.strictObject({
    label: z.string().min(1).max(100),
    description: z.string().max(250).optional(),
});

export const mobileAttentionQuestionSchema = z.strictObject({
    question: z.string().min(1).max(500),
    header: z.string().max(100),
    multiSelect: z.boolean(),
    options: z.array(attentionOptionSchema).max(8),
});

export const mobileAttentionRequestSchema = z.strictObject({
    id: identifierSchema,
    sessionId: identifierSchema,
    terminalId: identifierSchema,
    kind: z.enum(['permission', 'question']),
    status: z.enum(['pending', 'answered', 'applied', 'superseded', 'expired', 'failed']),
    toolName: z.string().max(100),
    summary: z.string().max(500),
    questions: z.array(mobileAttentionQuestionSchema).max(4),
    expiresAt: z.number().int().positive(),
});

export const mobileAttentionAnswerParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    requestId: identifierSchema,
    decision: z.enum(['allow', 'deny']).optional(),
    answers: z.record(z.string().min(1).max(500), z.string().max(500)).optional(),
});
