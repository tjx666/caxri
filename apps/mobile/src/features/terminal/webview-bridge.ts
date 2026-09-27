import { encodeHex } from '@caxri/mobile-transport';
import { z } from 'zod';

import { TERMINAL_WHEEL_MAX_LINES } from './view-scale';

const terminalIdSchema = z.string().regex(/^[\w-]{1,200}$/u);
const baseMessage = { version: z.literal(1), terminalId: terminalIdSchema };

const fromWebviewSchema = z.discriminatedUnion('type', [
    z.strictObject({ ...baseMessage, type: z.literal('ready') }),
    z.strictObject({ ...baseMessage, type: z.literal('tap') }),
    z.strictObject({ ...baseMessage, type: z.literal('scroll'), atBottom: z.boolean() }),
    z.strictObject({
        ...baseMessage,
        type: z.literal('size'),
        cols: z.number().int().min(2).max(1_000),
        rows: z.number().int().min(1).max(1_000),
    }),
    z.strictObject({
        ...baseMessage,
        type: z.literal('wheel'),
        lines: z
            .number()
            .int()
            .min(-TERMINAL_WHEEL_MAX_LINES)
            .max(TERMINAL_WHEEL_MAX_LINES)
            .refine((lines) => lines !== 0),
        col: z.number().int().min(1).max(1_000),
        row: z.number().int().min(1).max(1_000),
    }),
    z.strictObject({ ...baseMessage, type: z.literal('error'), code: z.literal('render-failed') }),
]);

const toWebviewSchema = z.discriminatedUnion('type', [
    z.strictObject({
        ...baseMessage,
        type: z.literal('reset'),
        cols: z.number().int().min(2).max(1_000),
        rows: z.number().int().min(1).max(1_000),
    }),
    z.strictObject({
        ...baseMessage,
        type: z.literal('resize'),
        cols: z.number().int().min(2).max(1_000),
        rows: z.number().int().min(1).max(1_000),
    }),
    z.strictObject({ ...baseMessage, type: z.literal('append'), data: z.string().max(24 * 1024) }),
    z.strictObject({ ...baseMessage, type: z.literal('jump') }),
    /**
     * `isLeased` draws the phone's own grid with a blinking cursor; `canForwardScroll` lets drags reach an
     * alternate-screen application through the Server's wheel encoding.
     */
    z.strictObject({
        ...baseMessage,
        type: z.literal('control'),
        canForwardScroll: z.boolean(),
        isLeased: z.boolean(),
    }),
]);

export type TerminalWebviewMessage = z.infer<typeof fromWebviewSchema>;
export type TerminalWebviewCommand = z.infer<typeof toWebviewSchema>;

export const parseTerminalWebviewMessage = (
    source: string,
    terminalId: string,
): TerminalWebviewMessage | null => {
    if (source.length > 2_048) return null;
    try {
        const result = fromWebviewSchema.safeParse(JSON.parse(source));
        return result.success && result.data.terminalId === terminalId ? result.data : null;
    } catch {
        return null;
    }
};

/**
 * The injected script carries only bounded ASCII hex, so Terminal output cannot become executable JavaScript.
 */
export const terminalWebviewCommandScript = (command: TerminalWebviewCommand): string => {
    const value = toWebviewSchema.parse(command);
    const encoded = encodeHex(new TextEncoder().encode(JSON.stringify(value)));
    return `window.CaxriTerminal.receiveHex('${encoded}');true;`;
};
