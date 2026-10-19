import { translate } from '../../i18n';
import { mobileErrorMessage } from '../connection/mobile-error-message';
import { MobileGatewayRequestError } from '../connection/mobile-gateway-client';

/**
 * The sentence for Terminal input or control that failed. Forbidden and conflicting control get Terminal-specific
 * wording; any other Server code gets the shared phone wording, and everything else, a timeout included, says delivery
 * is unconfirmed, because the input may still have reached the Terminal.
 */
export const terminalControlError = (error: unknown): string => {
    const unconfirmed = translate('terminal.error.deliveryUnconfirmed');
    if (!(error instanceof MobileGatewayRequestError)) return unconfirmed;
    if (error.code === 'FORBIDDEN') return translate('terminal.error.forbidden');
    if (error.code === 'CONFLICT') return translate('terminal.error.conflict');
    return mobileErrorMessage(error, unconfirmed);
};
