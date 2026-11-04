import { delegationHandBackRefusalSchema, isCaxriError } from '@caxri/protocol';

import type { Translate } from '../../i18n';

const REASON_KEYS = {
    not_taken_over: 'delegation.origin.handBackReason.not_taken_over',
    child_busy: 'delegation.origin.handBackReason.child_busy',
    child_changed: 'delegation.origin.handBackReason.child_changed',
    parent_gone: 'delegation.origin.handBackReason.parent_gone',
    parent_changed: 'delegation.origin.handBackReason.parent_changed',
} as const satisfies Record<string, Parameters<Translate>[0]>;

/**
 * The sentence for a refused hand-back, worded here from the Server's closed `details.reason` so it follows the app
 * language; `undefined` for any other failure, which the caller words as a generic failure.
 */
export function handBackRefusalText(error: unknown, t: Translate): string | undefined {
    if (!isCaxriError(error)) return undefined;
    const reason = delegationHandBackRefusalSchema.safeParse(
        (error.details as { reason?: unknown } | undefined)?.reason,
    );
    return reason.success ? t(REASON_KEYS[reason.data]) : undefined;
}
