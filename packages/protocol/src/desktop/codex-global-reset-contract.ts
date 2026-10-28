import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * Why the reset tracker could not be read. `network` covers offline, DNS, proxy, and timeout failures; `http` a non-2xx
 * answer; `invalidResponse` a body that no longer has the shape Main parses.
 */
export const codexGlobalResetFailureReasonSchema = z.enum(['network', 'http', 'invalidResponse']);
export type CodexGlobalResetFailureReason = z.infer<typeof codexGlobalResetFailureReasonSchema>;

const urlSchema = z.string().max(2_048);

const trackerFields = {
    /**
     * Epoch milliseconds when Main last tried the tracker, successful or not.
     */
    checkedAt: z.number(),
};

/**
 * The next Codex global reset as the public tracker reads it from the Codex lead's posts on X. A global reset restores
 * every paid account's 5-hour and weekly limits at once and has no fixed schedule, so the only time worth counting down
 * to is one that was announced: `scheduled` carries it, `none` means no dated announcement is pending.
 */
export const codexGlobalResetSchema = z.discriminatedUnion('state', [
    z.strictObject({
        ...trackerFields,
        state: z.literal('scheduled'),
        /**
         * Epoch milliseconds the announcement promised the reset by (`deadline`) or at (`exact`).
         */
        targetAt: z.number(),
        targetKind: z.enum(['deadline', 'exact']),
        /**
         * Epoch milliseconds the announcement was posted.
         */
        announcedAt: z.number(),
        /**
         * The announcement's own words, shown verbatim.
         */
        quote: z.string().max(500),
        postUrl: urlSchema,
    }),
    z.strictObject({ ...trackerFields, state: z.literal('none') }),
    z.strictObject({
        ...trackerFields,
        state: z.literal('unavailable'),
        reason: codexGlobalResetFailureReasonSchema,
    }),
]);
export type CodexGlobalReset = z.infer<typeof codexGlobalResetSchema>;

/**
 * Where the reading comes from. Its terms ask every surface that shows the data to credit it visibly.
 */
export const CODEX_GLOBAL_RESET_SOURCE = {
    name: 'codex-reset.com',
    url: 'https://codex-reset.com/',
} as const;

export const codexGlobalResetDesktopMethods = {
    /**
     * The next announced Codex global reset. Main reads the tracker through Chromium's network stack so the system
     * proxy applies, the same transport as `agentProviderStatus.read`, and caches the answer for a few minutes.
     */
    'codexGlobalReset.read': {
        ...commandPolicy('desktop', 'read'),
        params: z.object({}).default({}),
        result: codexGlobalResetSchema,
    },
} as const satisfies Record<string, MethodSpec>;
