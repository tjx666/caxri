import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';

import { CaxriError, fromWireError, type HostManifest } from '@caxri/protocol';
import { z } from 'zod';

import { discoverHostManifest } from './client.js';

const LEGACY_V1_PROTOCOL_VERSION = 1;
const MAX_LEGACY_V1_FRAME_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const RELEASE_POLL_INTERVAL_MS = 25;

/** Immutable v1 capability vocabulary; this migration path must not inherit future permissions. */
const legacyV1CapabilitySchema = z.enum([
    'desktop',
    'host.read',
    'host.stop',
    'events.read',
    'projects.read',
    'projects.write',
    'sessions.read',
    'sessions.write',
    'terminals.read',
    'terminals.control',
    'terminals.steer',
    'files.read',
    'files.write',
    'git.read',
    'git.control',
    'settings.read',
    'settings.write',
    'diagnostics.read',
    'agents.read',
    'agents.message',
    'agents.dispatch',
    'agents.control',
    'agents.grant',
    'desktop.window',
]);

const legacyWelcomeSchema = z.object({
    capabilities: z.array(legacyV1CapabilitySchema).max(64),
    commands: z.array(z.string().min(1).max(120)).max(256),
    principal: z.object({ id: z.string().min(1).max(200), kind: z.literal('human-cli') }),
    processIdentity: z.string().regex(/^[0-9a-f]{32}$/u),
    profileId: z.string().min(1).max(200),
    protocolVersion: z.literal(LEGACY_V1_PROTOCOL_VERSION),
    type: z.literal('welcome'),
});

const legacyReplySchema = z.object({
    reply: z.discriminatedUnion('ok', [
        z.object({
            id: z.string().min(1).max(200),
            ok: z.literal(true),
            protocolVersion: z.literal(LEGACY_V1_PROTOCOL_VERSION),
            result: z.unknown(),
        }),
        z.object({
            error: z.unknown(),
            id: z.string().min(1).max(200),
            ok: z.literal(false),
            protocolVersion: z.literal(LEGACY_V1_PROTOCOL_VERSION),
        }),
    ]),
    type: z.literal('reply'),
});

const legacyHostStatusSchema = z.object({
    activePtyCount: z.number().int().nonnegative(),
    clientCount: z.number().int().nonnegative(),
    pid: z.number().int().positive(),
    profileId: z.string().min(1).max(200),
    protocolCompatible: z.boolean(),
    protocolVersion: z.literal(LEGACY_V1_PROTOCOL_VERSION),
    startedAt: z.number().int().positive(),
    version: z.string().min(1).max(100),
});

const legacyHostStopSchema = z.object({
    activePtyCount: z.number().int().nonnegative(),
    stopping: z.literal(true),
});

export type LegacyV1HostStatus = z.infer<typeof legacyHostStatusSchema>;

interface PendingRequest {
    parse(value: unknown): unknown;
    reject(error: Error): void;
    resolve(value: unknown): void;
    timer: NodeJS.Timeout;
}

function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function parseLegacyFrame<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new CaxriError('VALIDATION', message);
    return parsed.data;
}

async function validatePrivateEndpoint(endpoint: string): Promise<void> {
    try {
        const metadata = await lstat(endpoint);
        if (
            !metadata.isSocket() ||
            (metadata.mode & 0o077) !== 0 ||
            (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        )
            throw new CaxriError('PATH_DENIED', 'Caxri Host endpoint is not private');
    } catch (error) {
        if (error instanceof CaxriError) throw error;
        if (fileSystemCode(error) === 'ENOENT')
            throw new CaxriError('UNAVAILABLE', 'Caxri Host endpoint is unavailable');
        throw error;
    }
}

function requireLegacyV1Manifest(manifest: HostManifest): HostManifest {
    if (manifest.protocolVersion !== LEGACY_V1_PROTOCOL_VERSION)
        throw new CaxriError('CONFLICT', 'Caxri Host is not a legacy v1 Host', {
            hostProtocolVersion: manifest.protocolVersion,
        });
    return manifest;
}

function requireSameHostManifest(expected: HostManifest, actual: HostManifest): void {
    if (
        actual.profileId !== expected.profileId ||
        actual.endpoint !== expected.endpoint ||
        actual.processIdentity !== expected.processIdentity
    )
        throw new CaxriError('CONFLICT', 'Caxri Host process identity changed');
}

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Migration-only operator control for stopping a v1 Host before its profile is upgraded to v2.
 *
 * This deliberately accepts only the historical v1 handshake and the two Host lifecycle commands;
 * it must never become a compatibility mode for the general-purpose v2 Host client.
 */
export class LegacyV1HostControl {
    private readonly pending = new Map<string, PendingRequest>();
    private closed = false;
    private source = '';

    private constructor(
        private readonly socket: Socket,
        private readonly manifest: HostManifest,
        private readonly userDataPath: string,
        private readonly timeoutMs: number,
    ) {
        socket.on('data', (chunk: Buffer | string) => this.receive(chunk.toString()));
        socket.on('close', () => this.failPending());
        socket.on('error', () => this.failPending());
    }

    static async connect(
        userDataPath: string,
        timeoutMs = DEFAULT_TIMEOUT_MS,
    ): Promise<LegacyV1HostControl> {
        const manifest = requireLegacyV1Manifest(await discoverHostManifest(userDataPath));
        await validatePrivateEndpoint(manifest.endpoint);
        const socket = createConnection(manifest.endpoint);
        socket.setEncoding('utf8');
        socket.setNoDelay(true);
        const handshake = await new Promise<{ remainder: string }>((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new CaxriError('TIMEOUT', 'Legacy v1 Caxri Host handshake timed out'));
            }, timeoutMs);
            let source = '';
            const fail = (): void => {
                clearTimeout(timer);
                reject(new CaxriError('UNAVAILABLE', 'Legacy v1 Caxri Host is unavailable'));
            };
            socket.once('error', fail);
            socket.once('close', fail);
            socket.on('data', (chunk: Buffer | string) => {
                source += chunk.toString();
                if (Buffer.byteLength(source, 'utf8') > MAX_LEGACY_V1_FRAME_BYTES) {
                    socket.destroy();
                    return;
                }
                const newline = source.indexOf('\n');
                if (newline === -1) return;
                try {
                    const welcome = parseLegacyFrame(
                        legacyWelcomeSchema,
                        JSON.parse(source.slice(0, newline)),
                        'Legacy v1 Caxri Host handshake was invalid',
                    );
                    if (
                        welcome.profileId !== manifest.profileId ||
                        welcome.processIdentity !== manifest.processIdentity
                    )
                        throw new CaxriError('CONFLICT', 'Caxri Host process identity changed');
                    if (
                        !welcome.capabilities.includes('host.read') ||
                        !welcome.capabilities.includes('host.stop') ||
                        !welcome.commands.includes('host.status') ||
                        !welcome.commands.includes('host.stop')
                    )
                        throw new CaxriError(
                            'FORBIDDEN',
                            'Legacy v1 Caxri Host does not grant lifecycle control',
                        );
                    clearTimeout(timer);
                    socket.pause();
                    socket.removeListener('error', fail);
                    socket.removeListener('close', fail);
                    socket.removeAllListeners('data');
                    resolve({ remainder: source.slice(newline + 1) });
                } catch (error) {
                    clearTimeout(timer);
                    socket.destroy();
                    reject(
                        error instanceof CaxriError
                            ? error
                            : new CaxriError(
                                  'VALIDATION',
                                  'Legacy v1 Caxri Host handshake was invalid',
                              ),
                    );
                }
            });
            socket.once('connect', () => {
                socket.write(
                    `${JSON.stringify({
                        credential: { kind: 'operator', token: manifest.operatorToken },
                        profileId: manifest.profileId,
                        supportedVersions: [LEGACY_V1_PROTOCOL_VERSION],
                        type: 'hello',
                    })}\n`,
                );
            });
        });
        const control = new LegacyV1HostControl(socket, manifest, userDataPath, timeoutMs);
        control.receive(handshake.remainder);
        socket.resume();
        return control;
    }

    status(): Promise<LegacyV1HostStatus> {
        return this.send('host.status', {}, legacyHostStatusSchema);
    }

    async stop(confirmLivePtys: boolean): Promise<void> {
        const current = requireLegacyV1Manifest(await discoverHostManifest(this.userDataPath));
        requireSameHostManifest(this.manifest, current);
        await this.send('host.stop', { confirmLivePtys }, legacyHostStopSchema);
    }

    async waitForRelease(): Promise<void> {
        const deadline = Date.now() + this.timeoutMs;
        while (true) {
            try {
                const current = await discoverHostManifest(this.userDataPath);
                requireSameHostManifest(this.manifest, current);
                requireLegacyV1Manifest(current);
            } catch (error) {
                if (error instanceof CaxriError && error.code === 'NOT_FOUND') return;
                throw error;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                throw new CaxriError('TIMEOUT', 'Legacy v1 Caxri Host did not release its profile');
            await wait(Math.min(RELEASE_POLL_INTERVAL_MS, remaining));
        }
    }

    close(): void {
        this.socket.destroy();
        this.failPending();
    }

    private receive(chunk: string): void {
        this.source += chunk;
        if (Buffer.byteLength(this.source, 'utf8') > MAX_LEGACY_V1_FRAME_BYTES) {
            this.closeWithValidationError();
            return;
        }
        let newline = this.source.indexOf('\n');
        while (newline !== -1) {
            const line = this.source.slice(0, newline);
            this.source = this.source.slice(newline + 1);
            try {
                const { reply } = parseLegacyFrame(
                    legacyReplySchema,
                    JSON.parse(line),
                    'Legacy v1 Caxri Host reply was invalid',
                );
                const pending = this.pending.get(reply.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(reply.id);
                    if (reply.ok) pending.resolve(pending.parse(reply.result));
                    else pending.reject(fromWireError(reply.error));
                }
            } catch {
                this.closeWithValidationError();
                return;
            }
            newline = this.source.indexOf('\n');
        }
    }

    private send<T>(
        method: 'host.status' | 'host.stop',
        params: Record<string, never> | { confirmLivePtys: boolean },
        schema: z.ZodType<T>,
    ): Promise<T> {
        if (this.closed)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Legacy v1 Caxri Host connection is closed'),
            );
        const id = randomUUID();
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new CaxriError('TIMEOUT', `Legacy v1 Caxri Host request timed out: ${method}`),
                );
            }, this.timeoutMs);
            this.pending.set(id, {
                parse: (value) =>
                    parseLegacyFrame(
                        schema,
                        value,
                        `Legacy v1 Caxri Host returned an invalid ${method} result`,
                    ),
                reject,
                resolve: (value) => resolve(value as T),
                timer,
            });
            this.socket.write(
                `${JSON.stringify({
                    request: {
                        id,
                        method,
                        params,
                        protocolVersion: LEGACY_V1_PROTOCOL_VERSION,
                    },
                    type: 'command',
                })}\n`,
            );
        });
    }

    private closeWithValidationError(): void {
        this.socket.destroy();
        this.failPending(new CaxriError('VALIDATION', 'Legacy v1 Caxri Host reply was invalid'));
    }

    private failPending(
        error = new CaxriError('UNAVAILABLE', 'Legacy v1 Caxri Host connection closed'),
    ): void {
        if (this.closed) return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}

/** Opens the migration-only v1 operator control for one selected Caxri profile. */
export function connectLegacyV1HostControl(
    userDataPath: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LegacyV1HostControl> {
    return LegacyV1HostControl.connect(userDataPath, timeoutMs);
}
