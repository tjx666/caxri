import type { HandshakeTranscript, MobileSessionKeys } from '@caxri/mobile-transport';
import {
    decodeHex,
    deriveMobileSessionKeys,
    encodeHex,
    handshakeConfirmation,
    MOBILE_TRANSPORT_VERSION,
    mobileClientConfirmationSchema,
    mobileClientHelloSchema,
    mobilePublicKey,
    mobileSealedFrameSchema,
    openMobileFrame,
    sealMobileFrame,
} from '@caxri/mobile-transport';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';

import {
    connectionId,
    deviceCredential,
    deviceId,
    serverId,
    serverNonce,
    serverSecret,
} from './mobile-gateway-fixture';

export class UnverifiedReconnectSocket extends EventTarget {
    constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    close(): void {
        this.dispatchEvent(new Event('close'));
    }

    send(source: string): void {
        const hello = mobileClientHelloSchema.parse(JSON.parse(source));
        if (hello.mode !== 'connect') throw new Error('Expected reconnect hello');
        const untrustedSecret = decodeHex('99'.repeat(32));
        const serverPublicKey = mobilePublicKey(untrustedSecret);
        const transcript: HandshakeTranscript = {
            mode: 'connect',
            serverId,
            principalId: `paired-device:${deviceId}`,
            connectionId: decodeHex(connectionId, 16),
            clientPublicKey: decodeHex(hello.clientPublicKey, 32),
            serverPublicKey,
            clientNonce: decodeHex(hello.clientNonce, 32),
            serverNonce,
        };
        const untrustedKeys = deriveMobileSessionKeys({
            localSecretKey: untrustedSecret,
            peerPublicKey: transcript.clientPublicKey,
            presharedKey: decodeHex('aa'.repeat(32)),
            transcript,
        });
        const data = JSON.stringify({
            type: 'challenge',
            version: MOBILE_TRANSPORT_VERSION,
            connectionId,
            deviceId,
            generation: 1,
            serverPublicKey: encodeHex(serverPublicKey),
            serverNonce: encodeHex(serverNonce),
            confirmation: encodeHex(handshakeConfirmation(untrustedKeys, 'server')),
        });
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
    }
}

/**
 * Reconnect peer that verifies the stored credential, then answers `ready` (or not) after the client confirms. Like the
 * Server, it answers requests that arrive before `ready` only after sending it. It records every sealed payload type in
 * arrival order, so a test can see what the client sent before `ready`.
 */
export class ConnectGatewaySocket extends EventTarget {
    #isReady = false;
    #keys?: MobileSessionKeys;
    readonly #pendingRequestIds: string[] = [];
    #serverCounter = 0;
    #transcript?: HandshakeTranscript;
    readonly #ready?: { deviceId: string; generation: number };
    /**
     * Sealed payload types received after the confirmation, with `confirm` marking where it arrived.
     */
    readonly received: string[] = [];
    readonly closeCodes: Array<number | undefined> = [];

    constructor(ready: 'never' | { deviceId?: string; generation?: number } = {}) {
        super();
        if (ready !== 'never')
            this.#ready = {
                deviceId: ready.deviceId ?? deviceId,
                generation: ready.generation ?? 1,
            };
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    #message(value: unknown): void {
        const data = JSON.stringify(value);
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
    }

    #sealed(value: unknown): void {
        if (!this.#keys || !this.#transcript) throw new Error('Handshake is incomplete');
        const counter = this.#serverCounter++;
        const ciphertext = sealMobileFrame(
            this.#keys.serverToClient,
            {
                connectionId: this.#transcript.connectionId,
                counter,
                deviceId,
                direction: 'server-to-client',
            },
            new TextEncoder().encode(JSON.stringify(value)),
        );
        this.#message({
            type: 'sealed',
            version: MOBILE_TRANSPORT_VERSION,
            connectionId,
            counter,
            ciphertext: encodeHex(ciphertext),
        });
    }

    #replyToRequest(id: string): void {
        this.#sealed({
            type: 'reply',
            reply: {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id,
                ok: true,
                result: {
                    view: 'paired-device',
                    projects: [{ id: 'project-1', title: 'Fixture' }],
                },
            },
        });
    }

    close(code?: number): void {
        this.closeCodes.push(code);
        this.dispatchEvent(new Event('close'));
    }

    /**
     * Answers `ready` now; the constructor's identity decides whether it matches the client's credential.
     */
    sendReady(): void {
        if (!this.#ready) throw new Error('This peer never sends ready.');
        this.#sealed({ type: 'ready', ...this.#ready });
        this.#isReady = true;
        for (const id of this.#pendingRequestIds) this.#replyToRequest(id);
        this.#pendingRequestIds.length = 0;
    }

    send(source: string): void {
        const raw = JSON.parse(source) as unknown;
        const hello = mobileClientHelloSchema.safeParse(raw);
        if (hello.success) {
            if (hello.data.mode !== 'connect') throw new Error('Expected reconnect hello');
            const serverPublicKey = mobilePublicKey(serverSecret);
            this.#transcript = {
                mode: 'connect',
                serverId,
                principalId: `paired-device:${deviceId}`,
                connectionId: decodeHex(connectionId, 16),
                clientPublicKey: decodeHex(hello.data.clientPublicKey, 32),
                serverPublicKey,
                clientNonce: decodeHex(hello.data.clientNonce, 32),
                serverNonce,
            };
            this.#keys = deriveMobileSessionKeys({
                localSecretKey: serverSecret,
                peerPublicKey: this.#transcript.clientPublicKey,
                presharedKey: decodeHex(deviceCredential, 32),
                transcript: this.#transcript,
            });
            this.#message({
                type: 'challenge',
                version: MOBILE_TRANSPORT_VERSION,
                connectionId,
                deviceId,
                generation: 1,
                serverPublicKey: encodeHex(serverPublicKey),
                serverNonce: encodeHex(serverNonce),
                confirmation: encodeHex(handshakeConfirmation(this.#keys, 'server')),
            });
            return;
        }
        if (mobileClientConfirmationSchema.safeParse(raw).success) {
            this.received.push('confirm');
            return;
        }
        if (!this.#keys || !this.#transcript) throw new Error('Handshake is incomplete');
        const frame = mobileSealedFrameSchema.parse(raw);
        const plaintext = openMobileFrame(
            this.#keys.clientToServer,
            {
                connectionId: this.#transcript.connectionId,
                counter: frame.counter,
                deviceId,
                direction: 'client-to-server',
            },
            decodeHex(frame.ciphertext),
        );
        const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
            type: string;
            request?: { id: string };
        };
        this.received.push(payload.type);
        if (payload.type !== 'request' || !payload.request) return;
        if (this.#isReady) this.#replyToRequest(payload.request.id);
        else this.#pendingRequestIds.push(payload.request.id);
    }
}
