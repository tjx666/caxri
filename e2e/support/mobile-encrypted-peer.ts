import { randomBytes, randomUUID } from 'node:crypto';

import type { MobileTimelineReadResult } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, commandReplyEnvelopeSchema } from '@caxri/protocol';

// eslint-disable-next-line caxri/architecture-boundaries -- root E2E has no package link; this is the package public index.
import type {
    HandshakeTranscript,
    MobileSessionKeys,
} from '../../packages/mobile-transport/src/index.ts';
// eslint-disable-next-line caxri/architecture-boundaries -- root E2E has no package link; this is the package public index.
import {
    decodeHex,
    deriveMobileSessionKeys,
    encodeHex,
    handshakeConfirmation,
    isHandshakeConfirmationValid,
    MOBILE_TRANSPORT_VERSION,
    mobileClientConfirmationSchema,
    mobilePairingResultSchema,
    mobilePublicKey,
    mobileSealedFrameSchema,
    mobileServerHelloSchema,
    openMobileFrame,
    parseMobilePairingLink,
    sealMobileFrame,
} from '../../packages/mobile-transport/src/index.ts';

const TIMEOUT_MS = 10_000;

interface ConversationEvent {
    kind: string;
    subscriptionId: string;
}

export interface MobileEncryptedPeer {
    deviceId: string;
    close(): void;
    readTimeline(input: {
        before?: string;
        limit?: number;
        sessionId: string;
    }): Promise<MobileTimelineReadResult>;
    subscribeConversation(
        sessionId: string,
        onEvent: (event: ConversationEvent) => void,
    ): Promise<{
        unsubscribe(): Promise<void>;
    }>;
}

class MobilePeerRequestError extends Error {
    constructor(readonly code: string) {
        super('Encrypted mobile request failed');
    }
}

async function openPairingSocket(addresses: string[], port: number): Promise<WebSocket> {
    for (const address of addresses) {
        const socket = new WebSocket(`ws://${address}:${port}/mobile`);
        try {
            // eslint-disable-next-line no-await-in-loop -- each fallback address is tried only after the prior failure.
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject(new Error('Mobile peer socket timed out')),
                    TIMEOUT_MS,
                );
                socket.addEventListener(
                    'open',
                    () => {
                        clearTimeout(timeout);
                        resolve();
                    },
                    { once: true },
                );
                socket.addEventListener(
                    'error',
                    () => {
                        clearTimeout(timeout);
                        reject(new Error('Mobile peer socket failed'));
                    },
                    { once: true },
                );
            });
            return socket;
        } catch {
            socket.close();
        }
    }
    throw new Error('No isolated mobile gateway address was reachable');
}

/**
 * A synthetic paired peer exercises the real encrypted gateway without storing a pairing secret.
 */
export async function pairMobileEncryptedPeer(pairingLink: string): Promise<MobileEncryptedPeer> {
    const link = parseMobilePairingLink(pairingLink);
    const socket = await openPairingSocket(link.addresses, link.port);
    const queued: unknown[] = [];
    const waiting: Array<(value: unknown) => void> = [];
    socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const value: unknown = JSON.parse(event.data);
        const release = waiting.shift();
        if (release) release(value);
        else queued.push(value);
    });
    socket.addEventListener('close', () => {
        const releases = [...waiting];
        waiting.length = 0;
        for (const release of releases) release(null);
    });
    const nextWire = (timeoutMs = TIMEOUT_MS): Promise<unknown> => {
        if (queued.length > 0) return Promise.resolve(queued.shift());
        return new Promise((resolve, reject) => {
            const timeout =
                timeoutMs > 0
                    ? setTimeout(
                          () => reject(new Error('Mobile peer response timed out')),
                          timeoutMs,
                      )
                    : undefined;
            waiting.push((value) => {
                clearTimeout(timeout);
                resolve(value);
            });
        });
    };
    const secret = randomBytes(32);
    const nonce = randomBytes(32);
    const publicKey = mobilePublicKey(secret);
    try {
        socket.send(
            JSON.stringify({
                type: 'hello',
                version: MOBILE_TRANSPORT_VERSION,
                mode: 'pair',
                pairingId: link.pairingId,
                displayName: 'Synthetic Android timeline peer',
                platform: 'android',
                clientPublicKey: encodeHex(publicKey),
                clientNonce: encodeHex(nonce),
            }),
        );
        const challenge = mobileServerHelloSchema.parse(await nextWire());
        const transcript: HandshakeTranscript = {
            mode: 'pair',
            serverId: link.serverId,
            principalId: `paired-device:${challenge.deviceId}`,
            connectionId: decodeHex(challenge.connectionId, 16),
            clientPublicKey: publicKey,
            serverPublicKey: decodeHex(challenge.serverPublicKey, 32),
            clientNonce: nonce,
            serverNonce: decodeHex(challenge.serverNonce, 32),
        };
        const keys: MobileSessionKeys = deriveMobileSessionKeys({
            localSecretKey: secret,
            peerPublicKey: transcript.serverPublicKey,
            presharedKey: decodeHex(link.secret, 32),
            transcript,
        });
        if (!isHandshakeConfirmationValid(decodeHex(challenge.confirmation, 32), keys, 'server'))
            throw new Error('Synthetic mobile peer could not verify the gateway');
        const confirmation = mobileClientConfirmationSchema.parse({
            type: 'confirm',
            version: MOBILE_TRANSPORT_VERSION,
            connectionId: challenge.connectionId,
            confirmation: encodeHex(handshakeConfirmation(keys, 'client')),
        });
        socket.send(JSON.stringify(confirmation));
        let receivedCounter = -1;
        let sentCounter = 0;
        const decode = (value: unknown): unknown => {
            const frame = mobileSealedFrameSchema.parse(value);
            if (frame.connectionId !== challenge.connectionId || frame.counter <= receivedCounter)
                throw new Error('Synthetic mobile peer frame identity or counter changed');
            receivedCounter = frame.counter;
            const plain = openMobileFrame(
                keys.serverToClient,
                {
                    connectionId: transcript.connectionId,
                    counter: frame.counter,
                    deviceId: challenge.deviceId,
                    direction: 'server-to-client',
                },
                decodeHex(frame.ciphertext),
            );
            return JSON.parse(new TextDecoder().decode(plain)) as unknown;
        };
        mobilePairingResultSchema.parse(decode(await nextWire()));
        const pending = new Map<
            string,
            { reject(error: Error): void; resolve(value: unknown): void }
        >();
        const listeners = new Map<string, (event: ConversationEvent) => void>();
        let isClosed = false;
        const send = (value: unknown): void => {
            const counter = sentCounter++;
            const ciphertext = sealMobileFrame(
                keys.clientToServer,
                {
                    connectionId: transcript.connectionId,
                    counter,
                    deviceId: challenge.deviceId,
                    direction: 'client-to-server',
                },
                new TextEncoder().encode(JSON.stringify(value)),
            );
            const frame = mobileSealedFrameSchema.parse({
                type: 'sealed',
                version: MOBILE_TRANSPORT_VERSION,
                connectionId: challenge.connectionId,
                counter,
                ciphertext: encodeHex(ciphertext),
            });
            socket.send(JSON.stringify(frame));
        };
        const sendWithReply = (id: string, payload: unknown): Promise<unknown> =>
            new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error('Synthetic mobile peer reply timed out'));
                }, TIMEOUT_MS);
                pending.set(id, {
                    reject: (error) => {
                        clearTimeout(timeout);
                        reject(error);
                    },
                    resolve: (value) => {
                        clearTimeout(timeout);
                        resolve(value);
                    },
                });
                try {
                    send(payload);
                } catch {
                    pending.delete(id);
                    clearTimeout(timeout);
                    reject(new Error('Synthetic mobile peer send failed'));
                }
            });
        const request = (value: Record<string, unknown>): Promise<unknown> => {
            const id = `mobile_${randomUUID().replaceAll('-', '')}`;
            return sendWithReply(id, {
                type: 'request',
                request: { protocolVersion: CAXRI_PROTOCOL_VERSION, id, ...value },
            });
        };
        const control = (value: {
            type: 'subscribe' | 'unsubscribe';
            resource?: unknown;
            subscriptionId?: string;
        }): Promise<unknown> => {
            const id = `mobile_${randomUUID().replaceAll('-', '')}`;
            return sendWithReply(id, { ...value, id });
        };
        void (async () => {
            try {
                while (!isClosed) {
                    // eslint-disable-next-line no-await-in-loop -- encrypted frames must be opened in counter order.
                    const payload = decode(await nextWire(0)) as Record<string, unknown>;
                    if (payload.type === 'reply') {
                        const reply = commandReplyEnvelopeSchema.parse(payload.reply);
                        const waiter = reply.id && pending.get(reply.id);
                        if (!waiter) throw new Error('Unexpected synthetic mobile peer reply');
                        pending.delete(reply.id!);
                        if (reply.ok) waiter.resolve(reply.result);
                        else waiter.reject(new MobilePeerRequestError(reply.error.code));
                    } else if (payload.type === 'event') {
                        const event = payload as unknown as ConversationEvent;
                        listeners.get(event.subscriptionId)?.(event);
                    }
                }
            } catch {
                for (const waiter of pending.values())
                    waiter.reject(new Error('Synthetic mobile peer disconnected'));
            }
        })();
        return {
            deviceId: challenge.deviceId,
            close: () => {
                isClosed = true;
                socket.close();
                for (const waiter of pending.values())
                    waiter.reject(new Error('Synthetic mobile peer closed'));
                pending.clear();
                listeners.clear();
            },
            readTimeline: (input) =>
                request({
                    method: 'mobile.timeline.read',
                    params: input,
                }) as Promise<MobileTimelineReadResult>,
            subscribeConversation: async (sessionId, onEvent) => {
                const result = (await control({
                    type: 'subscribe',
                    resource: { kind: 'conversation', sessionId },
                })) as { subscriptionId: string };
                listeners.set(result.subscriptionId, onEvent);
                return {
                    unsubscribe: async () => {
                        listeners.delete(result.subscriptionId);
                        await control({
                            type: 'unsubscribe',
                            subscriptionId: result.subscriptionId,
                        });
                    },
                };
            },
        };
    } catch (error) {
        socket.close();
        throw error;
    }
}
