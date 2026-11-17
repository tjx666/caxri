import type { ExtensionError } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';

import type { Translate } from '../../i18n';

/**
 * Closed reasons an extension-backed surface explains to the user. Recovery UI shows one of these instead of the raw
 * error message, which is an English diagnostic that can carry extension internals and local paths.
 */
export type ExtensionFailureReason =
    'interrupted' | 'timeout' | 'busy' | 'denied' | 'tooLarge' | 'generic';

/**
 * Classifies an extension failure published in the catalog.
 */
function extensionFailureReason(error: ExtensionError): ExtensionFailureReason {
    switch (error.code) {
        case 'EXTENSION_HOST_UNAVAILABLE':
        case 'GENERATION_EXPIRED':
            return 'interrupted';
        case 'PROVIDER_TIMEOUT':
            return 'timeout';
        case 'PROVIDER_CAPACITY':
            return 'busy';
        case 'CAPABILITY_DENIED':
        case 'PROJECT_SCOPE_DENIED':
            return 'denied';
        case 'PAYLOAD_TOO_LARGE':
            return 'tooLarge';
        default:
            return 'generic';
    }
}

/**
 * Classifies a rejected Server request made on an extension's behalf, such as a tree view read. The Server maps
 * extension failures onto the cross-process {@link isCaxriError} taxonomy, and a request the client gave up on arrives
 * as `TIMEOUT`.
 */
export function extensionRequestFailureReason(error: unknown): ExtensionFailureReason {
    if (!isCaxriError(error)) return 'generic';
    switch (error.code) {
        case 'TIMEOUT':
            return 'timeout';
        case 'CAPACITY':
            return 'busy';
        case 'FORBIDDEN':
        case 'PATH_DENIED':
            return 'denied';
        case 'UNAVAILABLE':
            return 'interrupted';
        default:
            return 'generic';
    }
}

/**
 * Waits before each automatic retry of a read the Server rejected as busy. `CAPACITY` means the Server's admission
 * limit was full at that instant and is retryable; painting it as a failure left Project Status on an error screen the
 * user had to retry by hand after the Server had already recovered.
 */
const BUSY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

/**
 * Delay before automatic retry number `attempt` (zero-based) of a busy read, or undefined once the budget is spent and
 * the failure should be shown.
 */
export function busyRetryDelay(attempt: number): number | undefined {
    return BUSY_RETRY_DELAYS_MS[attempt];
}

export function describeExtensionFailureReason(
    reason: ExtensionFailureReason,
    t: Translate,
): string {
    switch (reason) {
        case 'interrupted':
            return t('viewContainers.extensionFailure.interrupted');
        case 'timeout':
            return t('viewContainers.extensionFailure.timeout');
        case 'busy':
            return t('viewContainers.extensionFailure.busy');
        case 'denied':
            return t('viewContainers.extensionFailure.denied');
        case 'tooLarge':
            return t('viewContainers.extensionFailure.tooLarge');
        case 'generic':
            return t('viewContainers.extensionFailure.generic');
    }
}

export function describeExtensionFailure(error: ExtensionError, t: Translate): string {
    return describeExtensionFailureReason(extensionFailureReason(error), t);
}
