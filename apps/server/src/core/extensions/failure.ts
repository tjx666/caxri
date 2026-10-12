import type { ExtensionError } from '@caxri/protocol';

/**
 * Normalizes an activation, view, or retry failure into the closed {@link ExtensionError} shape published in the
 * catalog. An unknown code becomes `ACTIVATION_FAILED`, and the message is bounded.
 */
export function extensionFailure(error: unknown): ExtensionError {
    const code =
        typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'ACTIVATION_FAILED';
    const allowed: Array<ExtensionError['code']> = [
        'MANIFEST_INVALID',
        'ENGINE_INCOMPATIBLE',
        'DUPLICATE_ID',
        'COMMONJS_ENTRY_UNSUPPORTED',
        'COMMONJS_API_UNSUPPORTED',
        'ELECTRON_IMPORT_DENIED',
        'API_IMPORT_UNOWNED',
        'ACTIVATION_FAILED',
        'PROVIDER_MISSING',
        'PROVIDER_FAILED',
        'PROVIDER_TIMEOUT',
        'PROVIDER_CAPACITY',
        'PAYLOAD_TOO_LARGE',
        'CAPABILITY_DENIED',
        'PROJECT_SCOPE_DENIED',
        'GENERATION_EXPIRED',
        'EXTENSION_HOST_UNAVAILABLE',
    ];
    return {
        code: allowed.includes(code as ExtensionError['code'])
            ? (code as ExtensionError['code'])
            : 'ACTIVATION_FAILED',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2_048),
    };
}
