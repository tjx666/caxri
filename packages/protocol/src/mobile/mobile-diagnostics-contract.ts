import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * Why the app's previous process ended abnormally, from Android's `ApplicationExitInfo` reason. A user swipe, an
 * update, or an ordinary background kill is never reported, so every value names a failure.
 */
const mobileExitReasonSchema = z.enum([
    'crash',
    'crash-native',
    'anr',
    'low-memory',
    'initialization-failure',
    'excessive-resource-usage',
]);

/**
 * A fully qualified Java class name, such as `java.lang.OutOfMemoryError`. The exception message and stack never leave
 * the phone, since either may quote Session or file content.
 */
const javaClassNameSchema = z
    .string()
    .max(256)
    .regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u);

export const mobileReportExitParametersSchema = z.strictObject({
    reason: mobileExitReasonSchema,
    /**
     * When the process ended, in epoch milliseconds; together with the device it identifies one exit.
     */
    exitedAt: z.number().int().positive(),
    exceptionClass: javaClassNameSchema.optional(),
    appVersion: z
        .string()
        .regex(/^\d{1,4}\.\d{1,3}\.\d{1,3}$/u)
        .max(16),
    /**
     * Android's `versionCode` of the build that exited.
     */
    buildNumber: z.number().int().positive().max(2_100_000_000),
});

/**
 * Diagnostics a paired phone reports about itself; see `docs/mobile/diagnostics.md`. Every role may report, since the
 * report reads no Desktop data.
 */
export const mobileDiagnosticsMethods = {
    'mobile.diagnostics.reportExit': {
        ...commandPolicy('server', 'control', ['sessions.read']),
        params: mobileReportExitParametersSchema,
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;

export type MobileExitReason = z.infer<typeof mobileExitReasonSchema>;
export type MobileReportExitParameters = z.infer<typeof mobileReportExitParametersSchema>;
