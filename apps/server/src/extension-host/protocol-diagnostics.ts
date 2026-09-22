import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

type ProtocolRejectionReason = 'parent-envelope' | 'child-envelope' | 'reply-result';

/**
 * Records the rejected boundary without admitting message contents or provider errors into diagnostics.
 */
export function logProtocolRejection(
    logger: Pick<StructuredLogger, 'write'>,
    reason: ProtocolRejectionReason,
): void {
    logger.write('error', logEventCatalog.extensionHost.invalidMessage, { fields: { reason } });
}
