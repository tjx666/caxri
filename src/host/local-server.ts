import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';

import {
    createCommandDispatcher,
    createProtocolWelcome,
    type CommandDispatcher,
    type CommandDispatcherOptions,
} from '../shared/ipc/dispatcher';
import { CaxriError } from '../shared/ipc/errors';
import type { ProtocolEventEnvelope, TransientRuntimeEvent } from '../shared/ipc/event-journal';
import {
    localClientCommandSchema,
    localClientHelloSchema,
    localServerEventSchema,
    localServerReplySchema,
    localServerWelcomeSchema,
    type LocalClientCommand,
    type LocalServerReply,
    type HostManifest,
} from '../shared/ipc/local-transport';
import type { CommandExecutionContext } from '../shared/ipc/principal';

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_SOCKET_BUFFER_BYTES = 2 * MAX_MESSAGE_BYTES;
const HANDSHAKE_TIMEOUT_MS = 2_000;

function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function tokenMatches(candidate: string, expected: string): boolean {
    const candidateDigest = createHash('sha256').update(candidate).digest();
    const expectedDigest = createHash('sha256').update(expected).digest();
    return timingSafeEqual(candidateDigest, expectedDigest);
}

function contextFor(kind: 'desktop' | 'human-cli'): CommandExecutionContext {
    const id = `${kind}:${randomBytes(12).toString('hex')}`;
    if (kind === 'desktop') return { capabilities: ['desktop'], principal: { kind, id } };
    return {
        capabilities: ['events.read', 'host.read', 'host.stop'],
        principal: { kind, id },
    };
}

export interface LocalHostServerOptions {
    adapters: CommandDispatcherOptions;
    manifest: HostManifest;
    onClientCountChanged?(count: number): void;
    onReplyFlushed?(request: LocalClientCommand['request'], reply: LocalServerReply['reply']): void;
}

/** Authenticated, profile-scoped UDS adapter for Desktop and human CLI clients. */
export class LocalHostServer {
    private readonly clients = new Set<Socket>();
    private readonly sockets = new Set<Socket>();
    private readonly dispatch: CommandDispatcher;
    private server?: Server;

    constructor(private readonly options: LocalHostServerOptions) {
        this.dispatch = createCommandDispatcher(options.adapters);
    }

    clientCount(): number {
        return this.clients.size;
    }

    async start(): Promise<void> {
        if (this.server) return;
        try {
            const existing = await lstat(this.options.manifest.endpoint);
            if (!existing.isSocket())
                throw new CaxriError('PATH_DENIED', 'Host endpoint path is not a Unix socket');
            throw new CaxriError('CONFLICT', 'Host endpoint is already in use');
        } catch (error) {
            if (fileSystemCode(error) !== 'ENOENT') throw error;
        }
        const server = createServer((socket) => this.accept(socket));
        this.server = server;
        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error): void => {
                    server.off('listening', onListening);
                    reject(error);
                };
                const onListening = (): void => {
                    server.off('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(this.options.manifest.endpoint);
            });
            await chmod(this.options.manifest.endpoint, 0o600);
        } catch (error) {
            this.server = undefined;
            if (server.listening)
                await new Promise<void>((resolve) => server.close(() => resolve()));
            if (error instanceof CaxriError) throw error;
            if (fileSystemCode(error) === 'EADDRINUSE')
                throw new CaxriError('CONFLICT', 'Host endpoint is already in use');
            throw new CaxriError('IO', 'Host endpoint failed to listen');
        }
    }

    broadcast(event: ProtocolEventEnvelope | TransientRuntimeEvent): void {
        const message = localServerEventSchema.parse({ type: 'event', event });
        for (const client of this.clients) this.write(client, message);
    }

    private accept(socket: Socket): void {
        this.sockets.add(socket);
        socket.setEncoding('utf8');
        socket.setNoDelay(true);
        const handshakeTimer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
        let context: CommandExecutionContext | undefined;
        let source = '';
        let queue = Promise.resolve();

        const remove = (): void => {
            clearTimeout(handshakeTimer);
            this.sockets.delete(socket);
            if (!this.clients.delete(socket)) return;
            this.options.onClientCountChanged?.(this.clients.size);
        };
        socket.on('close', remove);
        socket.on('error', () => undefined);
        socket.on('data', (chunk: string) => {
            source += chunk;
            if (Buffer.byteLength(source, 'utf8') > MAX_SOCKET_BUFFER_BYTES) {
                socket.destroy();
                return;
            }
            let newline = source.indexOf('\n');
            while (newline !== -1) {
                const line = source.slice(0, newline);
                source = source.slice(newline + 1);
                if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
                    socket.destroy();
                    return;
                }
                queue = queue
                    .then(async () => {
                        if (!context) {
                            const hello = localClientHelloSchema.parse(JSON.parse(line));
                            if (
                                hello.profileId !== this.options.manifest.profileId ||
                                !tokenMatches(hello.ownerToken, this.options.manifest.ownerToken)
                            ) {
                                socket.destroy();
                                return;
                            }
                            context = contextFor(hello.clientKind);
                            clearTimeout(handshakeTimer);
                            this.clients.add(socket);
                            this.options.onClientCountChanged?.(this.clients.size);
                            this.write(
                                socket,
                                localServerWelcomeSchema.parse({
                                    type: 'welcome',
                                    profileId: this.options.manifest.profileId,
                                    processIdentity: this.options.manifest.processIdentity,
                                    ...createProtocolWelcome(this.options.adapters, hello, context),
                                }),
                            );
                            return;
                        }
                        const command = localClientCommandSchema.parse(JSON.parse(line));
                        const reply = await this.dispatch(command.request, context);
                        this.write(
                            socket,
                            localServerReplySchema.parse({ type: 'reply', reply }),
                            () => this.options.onReplyFlushed?.(command.request, reply),
                        );
                    })
                    .catch(() => {
                        socket.destroy();
                    });
                newline = source.indexOf('\n');
            }
        });
    }

    private write(socket: Socket, message: unknown, flushed?: () => void): void {
        if (socket.destroyed || socket.writableLength > MAX_SOCKET_BUFFER_BYTES) {
            socket.destroy();
            return;
        }
        socket.write(`${JSON.stringify(message)}\n`, flushed);
    }

    async close(): Promise<void> {
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        this.clients.clear();
        this.options.onClientCountChanged?.(0);
        const server = this.server;
        this.server = undefined;
        if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}
