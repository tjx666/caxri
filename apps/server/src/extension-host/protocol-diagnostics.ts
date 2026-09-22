import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

/**
 * Canonical closed set of rejected protocol boundaries. `packages/system` cannot import this module, so the Acceptance
 * fault sequence keeps its own copy of these ids; a parity assertion in the supervisor tests fails when the two drift.
 */
export const extensionHostProtocolRejectionReasons = [
    'parent-envelope',
    'child-envelope',
    'reply-result',
] as const;

type ProtocolRejectionReason = (typeof extensionHostProtocolRejectionReasons)[number];

/**
 * Records the rejected boundary without admitting message contents or provider errors into diagnostics.
 */
export function logProtocolRejection(
    logger: Pick<StructuredLogger, 'write'>,
    reason: ProtocolRejectionReason,
): void {
    logger.write('error', logEventCatalog.extensionHost.invalidMessage, { fields: { reason } });
}
