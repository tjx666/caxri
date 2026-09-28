import type { MobileUpdateRecoveryPayload } from '@caxri/mobile-transport';
import {
    decodeHex,
    deriveMobileUpdateRecoveryKey,
    encodeHex,
    isMobileUpdateRecoveryProofEqual,
    MOBILE_UPDATE_RECOVERY_NONCE_BYTES,
    MOBILE_UPDATE_RECOVERY_PROTOCOL,
    mobileUpdateRecoveryChallengeSchema,
    mobileUpdateRecoveryClientProof,
    mobileUpdateRecoveryHelloSchema,
    mobileUpdateRecoveryPayloadSchema,
    mobileUpdateRecoveryProofSchema,
    mobileUpdateRecoveryRejectedSchema,
    mobileUpdateRecoveryResultSchema,
    mobileUpdateRecoveryServerProof,
    PAIRING_SECRET_BYTES,
} from '@caxri/mobile-transport';

import type { MobileCredential } from './credential-store';
import type { MobileGatewayRuntime } from './mobile-gateway-client';
import { openSocket } from './mobile-gateway-client';
import { createSocketReader } from './socket-reader';

const RECOVERY_STEP_TIMEOUT_MS = 10_000;

/**
 * Desktop refused the proof. It sends the same answer for an unpaired, revoked, or wrong credential, so the phone
 * cannot tell them apart either.
 */
export class MobileUpdateRecoveryRejectedError extends Error {
    constructor() {
        super('Caxri on your computer did not accept this pairing.');
        this.name = 'MobileUpdateRecoveryRejectedError';
    }
}

/**
 * Proves the stored pairing to a Desktop whose transport is newer than this app's and returns the Android update that
 * Desktop ships, with a fresh download URL. It runs on its own socket through the frozen `update-recovery-v1` exchange,
 * so it keeps working after any transport version bump; Desktop answers once and closes.
 */
export const recoverMobileUpdate = async (
    credential: MobileCredential,
    runtime: MobileGatewayRuntime,
): Promise<MobileUpdateRecoveryPayload> => {
    const clientNonce = runtime.randomBytes(MOBILE_UPDATE_RECOVERY_NONCE_BYTES);
    const socket = await openSocket(credential.addresses, credential.port, runtime);
    const reader = createSocketReader(socket);
    try {
        const hello = mobileUpdateRecoveryHelloSchema.parse({
            type: 'update-recovery-hello',
            protocol: MOBILE_UPDATE_RECOVERY_PROTOCOL,
            deviceId: credential.deviceId,
            generation: credential.generation,
            clientNonce: encodeHex(clientNonce),
        });
        socket.send(JSON.stringify(hello));
        const challenge = mobileUpdateRecoveryChallengeSchema.parse(
            await reader.next(RECOVERY_STEP_TIMEOUT_MS),
        );
        const key = deriveMobileUpdateRecoveryKey({
            credential: decodeHex(credential.credential, PAIRING_SECRET_BYTES),
            transcript: {
                clientNonce,
                deviceId: credential.deviceId,
                generation: credential.generation,
                serverId: credential.serverId,
                serverNonce: decodeHex(challenge.serverNonce, MOBILE_UPDATE_RECOVERY_NONCE_BYTES),
            },
        });
        const proof = mobileUpdateRecoveryProofSchema.parse({
            type: 'update-recovery-proof',
            protocol: MOBILE_UPDATE_RECOVERY_PROTOCOL,
            proof: encodeHex(mobileUpdateRecoveryClientProof(key)),
        });
        socket.send(JSON.stringify(proof));
        const answer = await reader.next(RECOVERY_STEP_TIMEOUT_MS);
        if (mobileUpdateRecoveryRejectedSchema.safeParse(answer).success)
            throw new MobileUpdateRecoveryRejectedError();
        const result = mobileUpdateRecoveryResultSchema.parse(answer);
        // Only the Desktop holding this pairing can produce the proof, so a LAN peer cannot swap the URL or the MD5.
        const expected = mobileUpdateRecoveryServerProof(key, result.payload);
        if (!isMobileUpdateRecoveryProofEqual(decodeHex(result.proof), expected))
            throw new Error('Caxri could not verify the update from your computer.');
        return mobileUpdateRecoveryPayloadSchema.parse(JSON.parse(result.payload) as unknown);
    } finally {
        reader.close();
        socket.close();
    }
};
