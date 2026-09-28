import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    decodeHex,
    deriveMobileUpdateRecoveryKey,
    encodeHex,
    isMobileUpdateRecoveryProofEqual,
    MOBILE_TRANSPORT_VERSION,
    mobileUpdateRecoveryChallengeSchema,
    mobileUpdateRecoveryClientProof,
    mobileUpdateRecoveryPayloadSchema,
    mobileUpdateRecoveryRejectedSchema,
    mobileUpdateRecoveryResultSchema,
    mobileUpdateRecoveryServerProof,
    mobileVersionMismatchSchema,
} from '@caxri/mobile-transport';
import type { CommandAdapter } from '@caxri/protocol';
import {
    MOBILE_UPDATE_APK_FILE,
    MOBILE_UPDATE_MANIFEST_FILE,
    mobileUpdateBundleSchema,
} from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import type { MobileDeviceRecord } from '../device-registry';
import { MobileGateway } from '../gateway';
import { readMobileUpdateSource } from '../update-bundle';
import {
    cleanupRegistryDirectories,
    nextMessage,
    openSocket,
    registryFixture,
} from './gateway-client.fixture';

const SERVER_ID = 'a'.repeat(32);
const APK_BYTES = new TextEncoder().encode('fake-apk-bytes');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await cleanupRegistryDirectories();
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

const bundleDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-recovery-'));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, MOBILE_UPDATE_APK_FILE), APK_BYTES);
    await writeFile(
        join(directory, MOBILE_UPDATE_MANIFEST_FILE),
        JSON.stringify({
            version: '0.0.77',
            versionCode: 77,
            sizeBytes: APK_BYTES.length,
            md5: 'a'.repeat(32),
        }),
    );
    return directory;
};

const openGateway = async ({ withBundle = true }: { withBundle?: boolean } = {}) => {
    const registry = await registryFixture();
    const record: MobileDeviceRecord = registry.preparePair({
        displayName: 'Test phone',
        platform: 'android',
        projectIds: ['project-1'],
    });
    await registry.commitPair(record);
    const directory = withBundle ? await bundleDirectory() : undefined;
    const invoke = vi.fn<CommandAdapter['invoke']>();
    const write = vi.fn();
    let nonce = 0x70;
    const gateway = new MobileGateway({
        adapters: { server: { invoke } },
        authorizePairedDeviceMethod: () => {},
        authorizeSubscription: () => Promise.resolve(),
        matchesSubscriptionEvent: () => Promise.resolve(true),
        bootId: 'b'.repeat(32),
        logger: { write },
        protocolIdentity: { serverId: SERVER_ID, stateEpoch: 'c'.repeat(32) },
        // Every call yields fresh bytes, so each exchange gets its own server nonce.
        random: (bytes) => new Uint8Array(bytes).fill(nonce++ % 256),
        registry,
        selectAddress: () => '127.0.0.1',
        updateSource: () => readMobileUpdateSource(directory),
    });
    const enabled = await gateway.enable();
    const url = `ws://${enabled.address}:${enabled.port}/mobile`;
    const outcomes = () =>
        write.mock.calls
            .filter((call) => call[1] === 'mobile_gateway.update_recovery')
            .map((call) => (call[2] as { fields: { outcome: string } }).fields.outcome);
    return { gateway, invoke, outcomes, record, registry, url };
};

const closed = (socket: WebSocket): Promise<number> =>
    new Promise((resolve) => {
        if (socket.readyState === 3) resolve(socket.readyState);
        else socket.once('close', (code) => resolve(code));
    });

/**
 * Drives one `update-recovery-v1` exchange the way an old phone does, returning the Server's answer and the proof it
 * sent so a test can replay it.
 */
const recover = async (
    url: string,
    identity: { credential: string; deviceId: string; generation: number },
    options: { clientNonce?: string; proof?: string } = {},
) => {
    const socket = await openSocket(url);
    const clientNonce =
        options.clientNonce ?? encodeHex(crypto.getRandomValues(new Uint8Array(32)));
    const challengeMessage = nextMessage(socket);
    socket.send(
        JSON.stringify({
            type: 'update-recovery-hello',
            protocol: 'update-recovery-v1',
            deviceId: identity.deviceId,
            generation: identity.generation,
            clientNonce,
        }),
    );
    const challenge = mobileUpdateRecoveryChallengeSchema.parse(await challengeMessage);
    const key = deriveMobileUpdateRecoveryKey({
        credential: decodeHex(identity.credential, 32),
        transcript: {
            clientNonce: decodeHex(clientNonce, 32),
            deviceId: identity.deviceId,
            generation: identity.generation,
            serverId: SERVER_ID,
            serverNonce: decodeHex(challenge.serverNonce, 32),
        },
    });
    const proof = options.proof ?? encodeHex(mobileUpdateRecoveryClientProof(key));
    const answerMessage = nextMessage(socket);
    const closeCode = closed(socket);
    socket.send(
        JSON.stringify({ type: 'update-recovery-proof', protocol: 'update-recovery-v1', proof }),
    );
    const answer = await answerMessage;
    return { answer, clientNonce, closeCode, key, proof, socket };
};

const expectRejected = (answer: unknown): void => {
    expect(mobileUpdateRecoveryRejectedSchema.parse(answer)).toEqual({
        type: 'update-recovery-rejected',
        protocol: 'update-recovery-v1',
    });
};

describe('MobileGateway update recovery', () => {
    it('lets a phone one transport version behind download the bundled APK', async () => {
        const { gateway, invoke, outcomes, record, url } = await openGateway();
        try {
            // The phone's ordinary reconnect speaks an older transport, so a Desktop one version ahead refuses it.
            const legacy = await openSocket(url);
            const mismatch = nextMessage(legacy);
            legacy.send(
                JSON.stringify({
                    type: 'hello',
                    version: MOBILE_TRANSPORT_VERSION - 1,
                    mode: 'connect',
                    deviceId: record.deviceId,
                    generation: record.generation,
                    clientPublicKey: '21'.repeat(32),
                    clientNonce: '31'.repeat(32),
                }),
            );
            expect(mobileVersionMismatchSchema.parse(await mismatch).supportedVersion).toBe(
                MOBILE_TRANSPORT_VERSION,
            );
            legacy.close();

            const { answer, closeCode, key } = await recover(url, record);
            const result = mobileUpdateRecoveryResultSchema.parse(answer);
            expect(
                isMobileUpdateRecoveryProofEqual(
                    decodeHex(result.proof),
                    mobileUpdateRecoveryServerProof(key, result.payload),
                ),
            ).toBe(true);
            const payload = mobileUpdateRecoveryPayloadSchema.parse(
                JSON.parse(result.payload) as unknown,
            );
            if (!payload.bundle || !('url' in payload)) throw new Error('Expected a download');
            // The frozen recovery payload carries exactly the manifest `mobile.update.check` returns.
            expect(mobileUpdateBundleSchema.parse(payload.bundle)).toEqual({
                version: '0.0.77',
                versionCode: 77,
                sizeBytes: APK_BYTES.length,
                md5: 'a'.repeat(32),
            });
            expect(payload.url).toMatch(
                /^http:\/\/127\.0\.0\.1:\d+\/mobile\/update\/[0-9a-f]{64}$/u,
            );
            expect(await closeCode).toBe(1_000);

            const response = await fetch(payload.url);
            expect(response.status).toBe(200);
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(APK_BYTES);
            expect(outcomes()).toEqual(['accepted']);
            expect(invoke).not.toHaveBeenCalled();
        } finally {
            await gateway.close();
        }
    });

    it('answers an authenticated phone without a URL when this Desktop build ships no APK', async () => {
        const { gateway, outcomes, record, url } = await openGateway({ withBundle: false });
        try {
            const { answer, key } = await recover(url, record);
            const result = mobileUpdateRecoveryResultSchema.parse(answer);
            expect(
                isMobileUpdateRecoveryProofEqual(
                    decodeHex(result.proof),
                    mobileUpdateRecoveryServerProof(key, result.payload),
                ),
            ).toBe(true);
            expect(JSON.parse(result.payload)).toEqual({ bundle: null });
            expect(outcomes()).toEqual(['no-bundle']);
        } finally {
            await gateway.close();
        }
    });

    it('gives unpaired, revoked, stale, and wrongly proven devices the same rejection and no URL', async () => {
        const { gateway, outcomes, record, registry, url } = await openGateway();
        try {
            const unpaired = await recover(url, {
                credential: record.credential,
                deviceId: `device_${'99'.repeat(16)}`,
                generation: 1,
            });
            expectRejected(unpaired.answer);

            const wrongCredential = await recover(url, { ...record, credential: '12'.repeat(32) });
            expectRejected(wrongCredential.answer);

            const stale = await recover(url, { ...record, generation: record.generation + 1 });
            expectRejected(stale.answer);

            await gateway.revoke(record.deviceId, record.generation);
            expect(registry.list()[0]?.revokedAt).toBeDefined();
            const revoked = await recover(url, record);
            expectRejected(revoked.answer);

            expect(outcomes()).toEqual(['unpaired', 'bad-proof', 'stale-generation', 'revoked']);
        } finally {
            await gateway.close();
        }
    });

    it('stops issuing and serving update URLs as soon as a revocation starts', async () => {
        const { gateway, outcomes, record, registry, url } = await openGateway();
        try {
            const issued = mobileUpdateRecoveryResultSchema.parse(
                (await recover(url, record)).answer,
            );
            const payload = mobileUpdateRecoveryPayloadSchema.parse(
                JSON.parse(issued.payload) as unknown,
            );
            if (!('url' in payload)) throw new Error('Expected a download');
            // Hold the registry's atomic write open: its memory still says "paired" until the file is replaced.
            const { promise: written, resolve: finishWrite } = Promise.withResolvers<void>();
            const revokeRecord = registry.revoke.bind(registry);
            vi.spyOn(registry, 'revoke').mockImplementation(async (...arguments_) => {
                await written;
                return revokeRecord(...arguments_);
            });
            const revoking = gateway.revoke(record.deviceId, record.generation);

            expectRejected((await recover(url, record)).answer);
            expect((await fetch(payload.url)).status).toBe(404);

            finishWrite();
            await revoking;
            expect(outcomes()).toEqual(['accepted', 'revoked']);
        } finally {
            await gateway.close();
        }
    });

    it('rejects a proof replayed into a later exchange', async () => {
        const { gateway, outcomes, record, url } = await openGateway();
        try {
            const first = await recover(url, record);
            mobileUpdateRecoveryResultSchema.parse(first.answer);
            // Same hello, same client nonce, same proof: only the Server's fresh nonce differs.
            const replayed = await recover(url, record, {
                clientNonce: first.clientNonce,
                proof: first.proof,
            });
            expectRejected(replayed.answer);
            expect(outcomes()).toEqual(['accepted', 'bad-proof']);
        } finally {
            await gateway.close();
        }
    });

    it('never lets a recovery socket continue into the application handshake', async () => {
        const { gateway, invoke, outcomes, record, url } = await openGateway();
        try {
            const socket = await openSocket(url);
            const challenge = nextMessage(socket);
            socket.send(
                JSON.stringify({
                    type: 'update-recovery-hello',
                    protocol: 'update-recovery-v1',
                    deviceId: record.deviceId,
                    generation: record.generation,
                    clientNonce: '31'.repeat(32),
                }),
            );
            mobileUpdateRecoveryChallengeSchema.parse(await challenge);
            const closeCode = closed(socket);
            socket.send(
                JSON.stringify({
                    type: 'hello',
                    version: MOBILE_TRANSPORT_VERSION,
                    mode: 'connect',
                    deviceId: record.deviceId,
                    generation: record.generation,
                    clientPublicKey: '21'.repeat(32),
                    clientNonce: '31'.repeat(32),
                }),
            );
            expect(await closeCode).not.toBe(1_000);
            expect(outcomes()).toEqual(['invalid-frame']);
            expect(invoke).not.toHaveBeenCalled();
        } finally {
            await gateway.close();
        }
    });
});
