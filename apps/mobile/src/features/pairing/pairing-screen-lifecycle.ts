import { isMobilePairingCancelledError } from '../connection/mobile-gateway-client';
import { pairingErrorMessage } from './pairing-error';
import type { PairingRouteParameters } from './pairing-link-route';
import { pairingLinkFromRouteParameters } from './pairing-link-route';

export const completePairing = async (
    pair: () => Promise<void>,
    isActive: () => boolean,
    onNavigate: () => void,
    onError: (message: string) => void,
): Promise<void> => {
    try {
        await pair();
        if (isActive()) onNavigate();
    } catch (pairingError) {
        if (isActive() && !isMobilePairingCancelledError(pairingError))
            onError(pairingErrorMessage(pairingError));
    }
};

export const readPairingLink = (
    parameters: PairingRouteParameters,
    onError: (message: string) => void,
): string | null => {
    try {
        return pairingLinkFromRouteParameters(parameters);
    } catch (error) {
        onError(pairingErrorMessage(error));
        return null;
    }
};
