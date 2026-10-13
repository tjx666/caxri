import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { MAX_TERMINAL_INPUT_LENGTH } from './domain.js';
import { identifierSchema, pathSchema } from './identifiers.js';

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

const savedLongPasteFields = {
    characterCount: z.number().int().min(1).max(MAX_LONG_PASTE_BYTES),
    filePath: pathSchema,
    lineCount: z
        .number()
        .int()
        .min(1)
        .max(MAX_LONG_PASTE_BYTES + 1),
};

/**
 * Where a saved paste lives and how big the original was, which is everything its reference tells the Agent.
 */
export const savedLongPasteSchema = z.object(savedLongPasteFields);
export type SavedLongPaste = z.infer<typeof savedLongPasteSchema>;

/**
 * What the Agent sees in place of the pasted text, in a Terminal, an Agent Chat message, or a Git review hand-off.
 *
 * Caxri used to summarize the paste itself with a low-cost model call before the Agent saw anything, which held
 * Terminal input for the length of that call and left nothing behind when it timed out. The Agent is better placed to
 * decide what the text is worth: it can read the file, grep it, or hand it to a small-model subagent. So this says
 * where the file is, how big it is, and names the subagent route, and then gets out of the way.
 */
export function formatLongPasteReference(result: SavedLongPaste): string {
    const lines = `${result.lineCount} ${result.lineCount === 1 ? 'line' : 'lines'}`;
    const characters = `${result.characterCount} ${result.characterCount === 1 ? 'character' : 'characters'}`;
    return [
        '[Long paste saved locally]',
        `Original file: ${JSON.stringify(result.filePath)}`,
        `Original size: ${lines}, ${characters}`,
        '',
        'Read the original file for the exact content.',
        'If a summary is enough, delegate it to a subagent on a small, fast model so the full text stays out of this conversation.',
    ].join('\n');
}

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
        ...savedLongPasteFields,
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
