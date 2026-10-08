import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema, MAX_TERMINAL_INPUT_LENGTH, pathSchema } from './domain.js';

/**
 * Bounds one saved paste independently of the smaller native Terminal input budget.
 */
export const MAX_LONG_PASTE_BYTES = 16 * 1024 * 1024;

/**
 * UTF-16 length alone cannot enforce a file's UTF-8 byte budget.
 */
export function isLongPasteWithinLimit(content: string): boolean {
    return (
        content.length <= MAX_LONG_PASTE_BYTES &&
        new TextEncoder().encode(content).byteLength <= MAX_LONG_PASTE_BYTES
    );
}

export const terminalLongPasteParametersSchema = z.object({
    terminalId: identifierSchema,
    content: z.string().min(1).max(MAX_LONG_PASTE_BYTES).refine(isLongPasteWithinLimit, {
        message: 'Pasted text exceeds the local file safety limit',
    }),
});

/**
 * Long pastes are saved, never summarized.
 *
 * Caxri used to spend a low-cost model call on every long paste before the text reached the Agent, which held Terminal
 * input for as long as that call took and produced nothing when it timed out. The Agent is better placed to decide
 * whether a summary is worth paying for (it can read the file, grep it, or delegate to a small-model subagent) so the
 * Server's job ends at putting the original somewhere readable and saying where it is.
 */
export const terminalLongPasteResultSchema = z.discriminatedUnion('status', [
    /**
     * Shell-promoted Agents retain native paste without acquiring managed process control.
     */
    z.object({ status: z.literal('passthrough') }),
    z.object({
        agentLaunchId: identifierSchema,
        characterCount: z.number().int().min(1).max(MAX_LONG_PASTE_BYTES),
        filePath: pathSchema,
        lineCount: z
            .number()
            .int()
            .min(1)
            .max(MAX_LONG_PASTE_BYTES + 1),
        status: z.literal('saved'),
    }),
]);

export const terminalLongPasteMethods = {
    'terminal.inputAgentExact': {
        ...commandPolicy('server', 'control'),
        idempotency: 'none',
        params: z.object({
            terminalId: identifierSchema,
            data: z.string().min(1).max(MAX_TERMINAL_INPUT_LENGTH),
            expectedAgentLaunchId: identifierSchema,
        }),
        result: z.null(),
    },
    'terminal.prepareLongPaste': {
        ...commandPolicy('server', 'control'),
        idempotency: 'none',
        params: terminalLongPasteParametersSchema,
        result: terminalLongPasteResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type TerminalLongPasteResult = z.infer<typeof terminalLongPasteResultSchema>;
