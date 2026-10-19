import type { TranslationKey } from '../../i18n/resources';
import type { Translate } from '../../i18n/translate';
import { translate } from '../../i18n/translate';
import { MobileGatewayRequestError, MobileGatewayTimeoutError } from './mobile-gateway-errors';

/**
 * An error whose message the phone already translated before throwing it, so it is safe to show as is. Server and
 * library errors are English, so an arbitrary `Error.message` is never shown to the user.
 */
export class MobileLocalizedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MobileLocalizedError';
    }
}

/**
 * The Server error codes worth a specific sentence. Every other code (`VALIDATION`, `INTERNAL`, `IO`, `GIT`, ...)
 * carries English detail that is no use to a phone user, so it falls back to the entry's own generic message.
 */
const codeMessageKeys: Readonly<Partial<Record<string, TranslationKey>>> = {
    CAPACITY: 'connection.error.capacity',
    CONFLICT: 'connection.error.conflict',
    FORBIDDEN: 'connection.error.forbidden',
    NOT_FOUND: 'connection.error.notFound',
    PATH_DENIED: 'connection.error.pathDenied',
    TIMEOUT: 'connection.error.timeout',
    UNAVAILABLE: 'connection.error.unavailable',
};

/**
 * The user-facing text for a failed phone action, in the active language: a translated sentence for a known Server
 * error `code`, the error's own message when the phone translated it itself, and otherwise the entry's `fallback`
 * (already translated by the caller). It never shows a raw English `Error.message`.
 */
export const mobileErrorMessage = (
    error: unknown,
    fallback: string,
    t: Translate = translate,
): string => {
    if (error instanceof MobileLocalizedError && error.message) return error.message;
    if (error instanceof MobileGatewayTimeoutError) return t('connection.error.timeout');
    if (error instanceof MobileGatewayRequestError) {
        const key = codeMessageKeys[error.code];
        if (key) return t(key);
    }
    return fallback;
};
