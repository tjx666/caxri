import { encodeHex, MOBILE_TRANSPORT_VERSION, mobilePublicKey } from '@caxri/mobile-transport';

export const pairingClientHello = ({
    clientNonce,
    clientSecretKey,
    displayName,
    pairingId,
    platform,
}: {
    clientNonce: Uint8Array;
    clientSecretKey: Uint8Array;
    displayName: string;
    pairingId: string;
    platform: 'android' | 'ios';
}) => ({
    type: 'hello' as const,
    version: MOBILE_TRANSPORT_VERSION,
    mode: 'pair' as const,
    pairingId,
    displayName: displayName.trim().slice(0, 100) || 'Mobile device',
    platform,
    clientPublicKey: encodeHex(mobilePublicKey(clientSecretKey)),
    clientNonce: encodeHex(clientNonce),
});
