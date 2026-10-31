import { z } from 'zod';

import { remoteUpdateInstallResultSchema, updateStateSchema } from '../domain/update-state.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * What restarting the computer's Caxri ends, so the phone's confirmation can say it before the user agrees: running
 * Terminals and Chats, and Git review comments that were never sent.
 */
const mobileDesktopUpdateImpactSchema = z.strictObject({
    terminals: z.number().int().nonnegative().max(10_000),
    chats: z.number().int().nonnegative().max(10_000),
    pendingReviewComments: z.number().int().nonnegative().max(100_000),
});

/**
 * The computer's app update as the phone sees it. `offline`: no Desktop Main is attached, so nothing can be checked or
 * installed; `unsupported`: the attached Desktop does not own an app update (an SSH Host window). `impact` is present
 * only on a `ready` state, the one a restart can follow.
 */
const mobileDesktopUpdateResultSchema = z.discriminatedUnion('desktop', [
    z.strictObject({ desktop: z.literal('offline') }),
    z.strictObject({ desktop: z.literal('unsupported') }),
    z.strictObject({
        desktop: z.literal('online'),
        state: updateStateSchema,
        impact: mobileDesktopUpdateImpactSchema.optional(),
    }),
]);

const noParameters = z.strictObject({}).default({});

/**
 * Updating Caxri on the paired computer from the phone; see `docs/mobile/desktop-update.md`. Control devices only: the
 * restart ends every running Terminal and Chat on the Mac, beyond any one Project grant.
 */
export const mobileDesktopUpdateMethods = {
    'mobile.desktopUpdate.read': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        /**
         * `check` asks GitHub again first, like Desktop's **Check for Updates**; the answer is then usually `checking`.
         */
        params: z.strictObject({ check: z.boolean().optional() }).default({}),
        result: mobileDesktopUpdateResultSchema,
    },
    'mobile.desktopUpdate.download': {
        ...commandPolicy('server', 'control', ['sessions.read']),
        params: noParameters,
        result: mobileDesktopUpdateResultSchema,
    },
    'mobile.desktopUpdate.install': {
        ...commandPolicy('server', 'control', ['sessions.read']),
        /**
         * The version the user confirmed. A different staged version is refused rather than installed.
         */
        params: z.strictObject({ version: z.string().min(1).max(64) }),
        result: remoteUpdateInstallResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type MobileDesktopUpdateImpact = z.infer<typeof mobileDesktopUpdateImpactSchema>;
export type MobileDesktopUpdateResult = z.infer<typeof mobileDesktopUpdateResultSchema>;
