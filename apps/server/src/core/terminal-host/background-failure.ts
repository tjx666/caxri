import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

export async function observeBackgroundFailure(
    logger: StructuredLogger,
    promise: Promise<unknown>,
    method: string,
    terminalId?: string,
): Promise<void> {
    try {
        await promise;
    } catch (error) {
        logger.write('warn', logEventCatalog.terminalHost.error, {
            fields: {
                method,
                ...(terminalId && { terminalId }),
                errorType: error instanceof Error ? error.name : typeof error,
            },
        });
    }
}
