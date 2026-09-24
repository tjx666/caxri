import {
    MobilePairingError,
    MobileVersionMismatchError,
} from '../connection/mobile-gateway-client';

export const pairingErrorMessage = (error: unknown): string => {
    if (error instanceof MobileVersionMismatchError)
        return 'Update required. This app and Caxri on your computer use different versions. Update both to the latest build.';
    if (!(error instanceof MobilePairingError))
        return 'Pairing failed. Create a new code in Caxri Settings and try again.';
    switch (error.code) {
        case 'expired':
            return 'This pairing code expired. Create a new code in Caxri Settings.';
        case 'invalid-link':
            return 'This is not a valid Caxri pairing link. Copy or scan a new code.';
        case 'unreachable':
            return 'Caxri could not be reached. Check that Mobile access is on and both devices are on the same network.';
        case 'rejected':
            return 'Pairing was rejected. Create a new code in Caxri Settings and try again.';
    }
};
