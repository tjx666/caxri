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
