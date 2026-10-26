import { Buffer } from 'node:buffer';

import type { DesktopLease, ProtocolWelcome, ServerManifest } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    CONTROL_TRANSPORT_MAX_FRAME_BYTES,
    localServerWelcomeSchema,
    protocolFeatures,
    serverEndpointUrl,
} from '@caxri/protocol';
import type { RawData } from 'ws';
import WebSocket from 'ws';

import type { ServerClientCredential } from './client-support';
import { controlMessageText } from './client-support';
import { MAX_MANIFEST_BYTES } from './discovery';

/**
 * Result of a completed Server Core handshake. The socket is paused and the message listener is still attached so the
 * caller can swap it for the steady-state listener and replay `deferredMessages` without losing a frame.
 */
export interface ServerHandshakeResult {
    deferredMessages: Array<{ data: RawData; isBinary: boolean }>;
    desktopLease?: DesktopLease;
    handshakeMessageListener?: (data: RawData, isBinary: boolean) => void;
    resolvedCredential: ServerClientCredential;
    socket: WebSocket;
    welcome: ProtocolWelcome;
}

/**
 * Opens the control WebSocket and performs the `hello`/welcome exchange, validating process identity and durable
 * recovery identity before the caller wraps the socket in a `ServerClient`.
 */
export async function openServerHandshake(
    manifest: ServerManifest,
    timeoutMs: number,
    credential?: ServerClientCredential,
): Promise<ServerHandshakeResult> {
    if (manifest.protocolVersion !== CAXRI_PROTOCOL_VERSION)
        throw new CaxriError('CONFLICT', 'Caxri Server protocol version is incompatible', {
            clientProtocolVersion: CAXRI_PROTOCOL_VERSION,
            hostProtocolVersion: manifest.protocolVersion,
        });
    const resolvedCredential: ServerClientCredential = credential ?? { kind: 'operator' };
    const clientId =
        resolvedCredential.kind === 'operator'
            ? `operator:${manifest.profileId}`
            : resolvedCredential.kind === 'agent'
              ? `agent:${resolvedCredential.hostId}:${resolvedCredential.endpointId}`
              : resolvedCredential.kind === 'delegation-client'
                ? `delegation-client:${resolvedCredential.clientId}`
                : resolvedCredential.desktopId;
    const socket = new WebSocket(serverEndpointUrl(manifest.endpoint), {
        maxPayload: CONTROL_TRANSPORT_MAX_FRAME_BYTES,
    });
    const deferredMessages: Array<{ data: RawData; isBinary: boolean }> = [];
    let isHandshakeComplete = false;
    let handshakeMessageListener: ((data: RawData, isBinary: boolean) => void) | undefined;
    const handshake = await new Promise<{
        desktopLease?: DesktopLease;
        welcome: ProtocolWelcome;
    }>((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.terminate();
            reject(new CaxriError('TIMEOUT', 'Caxri Server handshake timed out'));
        }, timeoutMs);
        const fail = (): void => {
            clearTimeout(timer);
            reject(new CaxriError('UNAVAILABLE', 'Caxri Server is unavailable'));
        };
        socket.once('error', fail);
        socket.once('close', fail);
        handshakeMessageListener = (data, isBinary): void => {
            if (isHandshakeComplete) {
                deferredMessages.push({ data, isBinary });
                return;
            }
            if (isBinary) {
                socket.terminate();
                return;
            }
            const source = controlMessageText(data);
            if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
                socket.terminate();
                return;
            }
            try {
                const message = localServerWelcomeSchema.parse(JSON.parse(source));
                if (
                    message.profileId !== manifest.profileId ||
                    message.processIdentity !== manifest.processIdentity
                )
                    throw new CaxriError('CONFLICT', 'Caxri Server process identity changed');
                const isNegotiatedDurableRecovery =
                    message.features?.includes('durable-command-receipts-v1') === true ||
                    message.features?.includes('durable-changefeed-v1') === true;
                if (
                    isNegotiatedDurableRecovery &&
                    (!message.connection ||
                        message.connection.clientId !== clientId ||
                        message.connection.bootId !== manifest.processIdentity)
                )
                    throw new CaxriError(
                        'CONFLICT',
                        'Caxri Server durable recovery identity does not match this connection',
                    );
                clearTimeout(timer);
                isHandshakeComplete = true;
                socket.pause();
                socket.removeListener('error', fail);
                socket.removeListener('close', fail);
                resolve({
                    welcome: message,
                    ...(message.desktopLease && { desktopLease: message.desktopLease }),
                });
            } catch (error) {
                clearTimeout(timer);
                socket.terminate();
                reject(
                    error instanceof CaxriError
                        ? error
                        : new CaxriError('VALIDATION', 'Caxri Server handshake was invalid'),
                );
            }
        };
        socket.on('message', handshakeMessageListener);
        socket.once('open', () => {
            socket.send(
                JSON.stringify({
                    type: 'hello',
                    supportedVersions: [CAXRI_PROTOCOL_VERSION],
                    clientId,
                    features: protocolFeatures,
                    profileId: manifest.profileId,
                    credential:
                        resolvedCredential.kind === 'operator'
                            ? { kind: 'operator', token: manifest.operatorToken }
                            : resolvedCredential.kind === 'agent' ||
                                resolvedCredential.kind === 'delegation-client'
                              ? resolvedCredential
                              : {
                                    kind: 'desktop',
                                    token: resolvedCredential.credential.desktopToken,
                                    desktopId: resolvedCredential.desktopId,
                                },
                }),
            );
        });
    });
    return {
        deferredMessages,
        desktopLease: handshake.desktopLease,
        handshakeMessageListener,
        resolvedCredential,
        socket,
        welcome: handshake.welcome,
    };
}
