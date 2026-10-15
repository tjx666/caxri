import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import {
    MobilePairingError,
    MobileVersionMismatchError,
} from '../connection/mobile-gateway-client';

export const pairingErrorMessage = (error: unknown, t: Translate = translate): string => {
    if (error instanceof MobileVersionMismatchError) return t('pairing.error.versionMismatch');
    if (!(error instanceof MobilePairingError)) return t('pairing.error.failed');
    switch (error.code) {
        case 'expired':
            return t('pairing.error.expired');
        case 'invalid-link':
            return t('pairing.error.invalidLink');
        case 'unreachable':
            return t('pairing.error.unreachable');
        case 'rejected':
            return t('pairing.error.rejected');
    }
};
