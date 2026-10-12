import type { ExtensionError } from '@caxri/protocol';

import type { Translate } from '../../i18n';

/**
 * Closed protocol reasons keep extension internals and local paths out of recovery UI.
 */
export function describeExtensionFailure(error: ExtensionError, t: Translate): string {
    switch (error.code) {
        case 'EXTENSION_HOST_UNAVAILABLE':
        case 'GENERATION_EXPIRED':
            return t('viewContainers.extensionFailure.interrupted');
        case 'PROVIDER_TIMEOUT':
            return t('viewContainers.extensionFailure.timeout');
        case 'PROVIDER_CAPACITY':
            return t('viewContainers.extensionFailure.busy');
        case 'CAPABILITY_DENIED':
        case 'PROJECT_SCOPE_DENIED':
            return t('viewContainers.extensionFailure.denied');
        case 'PAYLOAD_TOO_LARGE':
            return t('viewContainers.extensionFailure.tooLarge');
        default:
            return t('viewContainers.extensionFailure.generic');
    }
}
