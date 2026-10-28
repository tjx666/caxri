import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { terminalSurfaceSchema } from '../domain/terminal-surface.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * Bounds one coalesced mobile scroll frame. Negative values scroll toward earlier output.
 */
export const MOBILE_TERMINAL_WHEEL_MAX_LINES = 50;

export const mobileTerminalWheelLinesSchema = z
    .number()
    .int()
    .min(-MOBILE_TERMINAL_WHEEL_MAX_LINES)
    .max(MOBILE_TERMINAL_WHEEL_MAX_LINES)
    .refine((lines) => lines !== 0, 'Scroll must move at least one line');

/**
 * One coalesced mobile scroll frame at a 1-based grid cell. Negative `lines` scroll toward earlier output.
 */
export interface TerminalWheelInput {
    col: number;
    lines: number;
    row: number;
}

/**
 * Live Terminal control from a paired device. Every call is fenced to one gateway subscription and PTY generation.
 */
export const mobileTerminalMethods = {
    'mobile.terminal.takeOver': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({
            terminalId: identifierSchema,
            subscriptionId: identifierSchema,
            expectedGeneration: z.number().int().positive(),
            cols: z.number().int().min(2).max(1_000),
            rows: z.number().int().min(1).max(1_000),
        }),
        result: z.strictObject({ expiresAt: z.number().int().positive() }),
    },
    'mobile.terminal.release': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({
            terminalId: identifierSchema,
            subscriptionId: identifierSchema,
            expectedGeneration: z.number().int().positive(),
        }),
        result: z.null(),
    },
    'mobile.terminal.input': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({
            terminalId: identifierSchema,
            subscriptionId: identifierSchema,
            expectedGeneration: z.number().int().positive(),
            data: z
                .string()
                .min(1)
                .refine(
                    (data) => new TextEncoder().encode(data).length <= 8 * 1_024,
                    'Mobile Terminal input must be at most 8 KiB',
                ),
        }),
        result: z.null(),
    },
    /**
     * Scrolls an alternate-screen or mouse-reporting application without a size lease. The Terminal Host encodes the
     * wheel from its own parsed modes, so this path can never carry arbitrary input bytes.
     */
    'mobile.terminal.scroll': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({
            terminalId: identifierSchema,
            subscriptionId: identifierSchema,
            expectedGeneration: z.number().int().positive(),
            lines: mobileTerminalWheelLinesSchema,
            col: z.number().int().min(1).max(1_000),
            row: z.number().int().min(1).max(1_000),
        }),
        result: z.null(),
    },
    /**
     * Reopens a granted Chat-capable Agent Terminal on the other surface through Desktop's own
     * `terminal.switchSurface`, so the phone and the tab rail share one switch and one running-turn guard. Unlike the
     * calls above it needs no subscription: the switch replaces the Terminal's process, so the phone re-reads the
     * Session instead of steering a live PTY. The result drops the Terminal record; the phone already refreshes the
     * Session it shows.
     */
    'mobile.terminal.switchSurface': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({
            terminalId: identifierSchema,
            surface: terminalSurfaceSchema,
            interruptTurn: z.boolean().default(false),
        }),
        result: z.discriminatedUnion('status', [
            z.strictObject({ status: z.literal('switched') }),
            z.strictObject({ status: z.literal('turnRunning') }),
        ]),
    },
} as const satisfies Record<string, MethodSpec>;
