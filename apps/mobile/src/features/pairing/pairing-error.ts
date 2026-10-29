import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import {
    MobilePairingError,
    MobileVersionMismatchError,
} from '../connection/mobile-gateway-client';
import { relayFailureKindOf } from '../connection/relay-failure';

export const pairingErrorMessage = (error: unknown, t: Translate = translate): string => {
    if (error instanceof MobileVersionMismatchError) return t('pairing.error.versionMismatch');
    switch (relayFailureKindOf(error)) {
        case 'host-offline':
            return t('pairing.error.hostOffline');
        case 'unauthorized':
            return t('pairing.error.relayUnauthorized');
        case 'busy':
            return t('pairing.error.relayBusy');
        case null:
            break;
    }
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
