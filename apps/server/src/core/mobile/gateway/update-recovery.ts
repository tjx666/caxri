import { Buffer } from 'node:buffer';

import type { MobileUpdateRecoveryHello } from '@caxri/mobile-transport';
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
    mobileUpdateRecoveryProofSchema,
    mobileUpdateRecoveryRejectedSchema,
    mobileUpdateRecoveryResultSchema,
    mobileUpdateRecoveryServerProof,
    PAIRING_SECRET_BYTES,
} from '@caxri/mobile-transport';

import type { MobileDeviceRegistry } from '../device-registry';
import type { MobileUpdateSource } from '../update-bundle';
import type { MobileUpdateDownloads } from './update-downloads';

/**
 * Closed outcome of one update-recovery exchange. `accepted` issued a download URL; `no-bundle` authenticated a device
 * on a Desktop build without an APK. `unpaired`, `revoked`, `stale-generation`, and `bad-proof` are the rejections the
 * phone cannot tell apart. `invalid-frame` is a malformed hello or proof, `unavailable` a gateway that stopped
 * listening mid-exchange, and `bundle-error` an APK that disagrees with its manifest.
 */
export type MobileUpdateRecoveryOutcome =
    | 'accepted'
    | 'bad-proof'
    | 'bundle-error'
    | 'invalid-frame'
    | 'no-bundle'
    | 'revoked'
    | 'stale-generation'
    | 'unavailable'
    | 'unpaired';

export interface MobileUpdateRecoveryDependencies {
    /**
     * Issues the same per-device download URL `mobile.update.prepare` returns.
     */
    downloads: Pick<MobileUpdateDownloads, 'issue'>;
    /**
     * A device whose revocation has started counts as revoked before the registry finishes writing it, matching how
     * that device's active sessions stop serving requests at the same moment.
     */
    isRevoking: (deviceId: string) => boolean;
    /**
     * The gateway's HTTP origin for this socket, or `undefined` once the gateway stopped listening.
     */
    origin: () => string | undefined;
    random: (bytes: number) => Uint8Array;
    registry: Pick<MobileDeviceRegistry, 'recoveryMaterial'>;
    serverId: string;
    updateSource?: () => Promise<MobileUpdateSource | undefined>;
}

export const isMobileUpdateRecoveryHello = (raw: unknown): boolean =>
    typeof raw === 'object' &&
    raw !== null &&
    'type' in raw &&
    raw.type === 'update-recovery-hello';

const rejectedFrame = JSON.stringify(
    mobileUpdateRecoveryRejectedSchema.parse({
        type: 'update-recovery-rejected',
        protocol: MOBILE_UPDATE_RECOVERY_PROTOCOL,
    }),
);

/**
 * One socket's `update-recovery-v1` exchange: hello, challenge, proof, then a single authenticated result or rejection.
 * It never creates a gateway session, so a recovered phone cannot reach the command dispatcher, subscriptions, or any
 * data beyond the APK manifest and its own download URL.
 */
export class MobileUpdateRecoveryExchange {
    /**
     * Throws on a malformed hello; the gateway terminates that socket as an invalid handshake.
     */
    static begin(
        raw: unknown,
        dependencies: MobileUpdateRecoveryDependencies,
    ): MobileUpdateRecoveryExchange {
        return new MobileUpdateRecoveryExchange(
            mobileUpdateRecoveryHelloSchema.parse(raw),
            dependencies,
        );
    }

    readonly #dependencies: MobileUpdateRecoveryDependencies;
    readonly #hello: MobileUpdateRecoveryHello;
    readonly #serverNonce: Uint8Array;
    readonly challenge: string;

    private constructor(
        hello: MobileUpdateRecoveryHello,
        dependencies: MobileUpdateRecoveryDependencies,
    ) {
        this.#hello = hello;
        this.#dependencies = dependencies;
        this.#serverNonce = dependencies.random(MOBILE_UPDATE_RECOVERY_NONCE_BYTES);
        this.challenge = JSON.stringify(
            mobileUpdateRecoveryChallengeSchema.parse({
                type: 'update-recovery-challenge',
                protocol: MOBILE_UPDATE_RECOVERY_PROTOCOL,
                serverNonce: encodeHex(this.#serverNonce),
            }),
        );
    }

    #material(): ReturnType<MobileDeviceRegistry['recoveryMaterial']> {
        const { deviceId, generation } = this.#hello;
        return this.#dependencies.isRevoking(deviceId)
            ? { kind: 'revoked' }
            : this.#dependencies.registry.recoveryMaterial(deviceId, generation);
    }

    #result(key: Uint8Array, value: unknown): string {
        const payload = JSON.stringify(value);
        const proof = encodeHex(mobileUpdateRecoveryServerProof(key, payload));
        const frame = mobileUpdateRecoveryResultSchema.parse({
            type: 'update-recovery-result',
            protocol: MOBILE_UPDATE_RECOVERY_PROTOCOL,
            payload,
            proof,
        });
        return JSON.stringify(frame);
    }

    /**
     * Verifies the proof against the device's current credential and answers with one frame to send before closing, or
     * no frame when the socket should simply be terminated.
     */
    async complete(
        raw: unknown,
    ): Promise<{ frame?: string; outcome: MobileUpdateRecoveryOutcome }> {
        const parsed = mobileUpdateRecoveryProofSchema.safeParse(raw);
        if (!parsed.success) return { outcome: 'invalid-frame' };
        const { deviceId, generation } = this.#hello;
        // Every exchange draws a stand-in credential and derives a key, so each rejection costs the same work.
        const standIn = Buffer.from(this.#dependencies.random(PAIRING_SECRET_BYTES)).toString(
            'hex',
        );
        const material = this.#material();
        const credential = material.kind === 'paired' ? material.credential : standIn;
        const key = deriveMobileUpdateRecoveryKey({
            credential: decodeHex(credential, PAIRING_SECRET_BYTES),
            transcript: {
                clientNonce: decodeHex(this.#hello.clientNonce),
                deviceId,
                generation,
                serverId: this.#dependencies.serverId,
                serverNonce: this.#serverNonce,
            },
        });
        const isProofValid = isMobileUpdateRecoveryProofEqual(
            decodeHex(parsed.data.proof),
            mobileUpdateRecoveryClientProof(key),
        );
        const rejection =
            material.kind === 'paired' ? (isProofValid ? undefined : 'bad-proof') : material.kind;
        if (rejection) return { frame: rejectedFrame, outcome: rejection };
        let source: MobileUpdateSource | undefined;
        try {
            source = await this.#dependencies.updateSource?.();
        } catch {
            return { frame: rejectedFrame, outcome: 'bundle-error' };
        }
        // Reading the bundle yields to other work; a revocation that landed meanwhile must still win.
        const current = this.#material();
        if (current.kind !== 'paired') return { frame: rejectedFrame, outcome: current.kind };
        if (!source) return { frame: this.#result(key, { bundle: null }), outcome: 'no-bundle' };
        const origin = this.#dependencies.origin();
        if (!origin) return { frame: rejectedFrame, outcome: 'unavailable' };
        const download = this.#dependencies.downloads.issue(
            { deviceId, generation },
            source,
            origin,
        );
        return {
            frame: this.#result(key, { bundle: source.bundle, ...download }),
            outcome: 'accepted',
        };
    }
}
