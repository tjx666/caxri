import type { ExtensionError } from '@caxri/protocol';

/**
 * Closed protocol reasons keep extension internals and local paths out of recovery UI.
 */
export function describeExtensionFailure(error: ExtensionError): string {
    switch (error.code) {
        case 'EXTENSION_HOST_UNAVAILABLE':
        case 'GENERATION_EXPIRED':
            return 'The extension connection was interrupted. Retry to reconnect.';
        case 'PROVIDER_TIMEOUT':
            return 'The extension did not respond in time. Try again.';
        case 'PROVIDER_CAPACITY':
            return 'The extension is busy. Wait a moment, then try again.';
        case 'CAPABILITY_DENIED':
        case 'PROJECT_SCOPE_DENIED':
            return 'The extension does not have access to this operation or Project.';
        case 'PAYLOAD_TOO_LARGE':
            return 'The extension returned more data than this view can display.';
        default:
            return 'The extension could not load this view. Retry, or check the extension configuration.';
    }
}
