import { z } from 'zod';

import { agentChatImageInputSchema } from '../agent/agent-chat-methods.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './identifiers.js';

function hasReportControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (code === 127 || (code !== 9 && code !== 10 && code !== 13 && code < 32)) return true;
    }
    return false;
}

export const bugReportText = z
    .string()
    .min(1)
    .max(48 * 1024)
    .refine((value) => !hasReportControlCharacter(value), 'Report contains control characters');

/**
 * The only data-URL shape a bug-report screenshot may take. Shared so the schema that validates it, the capture handler
 * that builds it, the Main handler that slices the base64 payload back off, and the Renderer rasterizer that re-encodes
 * an annotated copy can never drift into three slightly different literals.
 */
export const BUG_REPORT_JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

export const bugReportScreenshot = z.object({
    dataUrl: z
        .string()
        .startsWith(BUG_REPORT_JPEG_DATA_URL_PREFIX)
        .max(12 * 1024 * 1024),
    height: z.number().int().positive().max(16_384),
    width: z.number().int().positive().max(16_384),
});

/**
 * Keeps bug-report methods beside their content schemas rather than growing the central registry.
 */
export const bugReportMethods = {
    'bugReport.context': {
        ...commandPolicy('server', 'read'),
        params: z.object({}).default({}),
        result: z.object({
            appVersion: z.string().min(1).max(100),
            architecture: z.string().min(1).max(100),
            commit: z.string().min(1).max(100),
            platform: z.string().min(1).max(100),
            recentErrorIds: z.array(z.string().min(1).max(200)).max(5),
        }),
    },
    'bugReport.captureScreenshot': {
        ...commandPolicy('desktop', 'control'),
        params: z.object({}).default({}),
        result: bugReportScreenshot,
    },
    /**
     * Persists the previewed capture, so its authority is Desktop write rather than capture control.
     */
    'bugReport.saveScreenshot': {
        ...commandPolicy('desktop', 'write'),
        params: z.object({ dataUrl: bugReportScreenshot.shape.dataUrl }),
        result: z.object({ path: z.string().min(1).max(4_096) }),
    },
    'bugReport.send': {
        ...commandPolicy('desktop', 'write'),
        params: z.object({
            /**
             * The annotated screenshot already encoded as a Chat image attachment. Only an Agent Chat whose provider
             * accepts images (`capabilities.chatImages`) receives one; a PTY Agent takes `screenshot` instead.
             */
            chatImage: agentChatImageInputSchema.optional(),
            report: bugReportText,
            screenshot: bugReportScreenshot.optional(),
            sessionId: identifierSchema,
            terminalId: identifierSchema,
        }),
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;

export const bugReportInternalMethods = {
    'bugReport.deliver': {
        ...commandPolicy('server', 'control'),
        params: z.object({
            /**
             * Chat image attachments sent with the report as one message; only valid for an Agent Chat.
             */
            images: z.array(agentChatImageInputSchema).max(1).optional(),
            pasteImage: z.boolean(),
            report: bugReportText,
            sessionId: identifierSchema,
            terminalId: identifierSchema,
        }),
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;
