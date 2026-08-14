import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LegacyV1HostControl } from './legacy-v1-host-control';

const temporaryDirectories: string[] = [];
const operatorToken = 'a'.repeat(64);
const processIdentity = 'b'.repeat(32);

interface LegacyManifest {
    endpoint: string;
    operatorToken: string;
    pid: number;
    processIdentity: string;
    profileId: string;
    protocolVersion: number;
    startedAt: number;
    version: string;
}

interface ScriptedHostOptions {
    capabilities?: string[];
    commands?: string[];
    onCommand?(socket: Socket, frame: Record<string, unknown>): void;
    welcome?: Partial<Record<string, unknown>>;
}

interface ScriptedHost {
    close(): Promise<void>;
    frames: Record<string, unknown>[];
    manifest: LegacyManifest;
    userDataPath: string;
    writeManifest(manifest: LegacyManifest): Promise<void>;
}

function profileIdFor(path: string): string {
    return createHash('sha256').update(path).digest('hex').slice(0, 24);
}

function commandRequestId(frame: Record<string, unknown>): string {
    const request = frame.request;
    if (typeof request !== 'object' || request === null || !('id' in request))
        throw new Error('Expected a command request');
    const id = request.id;
    if (typeof id !== 'string') throw new Error('Expected a command request ID');
    return id;
}

function statusResult(manifest: LegacyManifest): Record<string, unknown> {
    return {
        activePtyCount: 0,
        clientCount: 1,
        pid: manifest.pid,
        profileId: manifest.profileId,
        protocolCompatible: true,
        protocolVersion: 1,
        startedAt: manifest.startedAt,
        version: manifest.version,
    };
}

async function startScriptedHost(options: ScriptedHostOptions = {}): Promise<ScriptedHost> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-cli-legacy-v1-'));
    temporaryDirectories.push(directory);
    const userDataPath = join(directory, 'profile');
    const hostDirectory = join(userDataPath, 'host');
    const endpoint = join(hostDirectory, 'host.sock');
    const manifestPath = join(hostDirectory, 'manifest.json');
    await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
    await chmod(hostDirectory, 0o700);
    const canonicalUserDataPath = await realpath(userDataPath);

    const manifest: LegacyManifest = {
        endpoint,
        operatorToken,
        pid: process.pid,
        processIdentity,
        profileId: profileIdFor(canonicalUserDataPath),
        protocolVersion: 1,
        startedAt: 1,
        version: '1.0.0',
    };
    const frames: Record<string, unknown>[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.setEncoding('utf8');
        socket.on('close', () => sockets.delete(socket));
        let source = '';
        socket.on('data', (chunk: string) => {
            source += chunk;
            let newline = source.indexOf('\n');
            while (newline !== -1) {
                const frame = JSON.parse(source.slice(0, newline)) as Record<string, unknown>;
                frames.push(frame);
                source = source.slice(newline + 1);
                if (frames.length === 1) {
                    socket.write(
                        `${JSON.stringify({
                            capabilities: options.capabilities ?? ['host.read', 'host.stop'],
                            commands: options.commands ?? ['host.status', 'host.stop'],
                            principal: { id: 'legacy-cli', kind: 'human-cli' },
                            processIdentity: manifest.processIdentity,
                            profileId: manifest.profileId,
                            protocolVersion: 1,
                            type: 'welcome',
                            ...options.welcome,
                        })}\n`,
                    );
                } else if (options.onCommand) {
                    options.onCommand(socket, frame);
                } else {
                    const request = frame.request as Record<string, unknown>;
                    const result =
                        request.method === 'host.status'
                            ? statusResult(manifest)
                            : { activePtyCount: 0, stopping: true };
                    socket.write(
                        `${JSON.stringify({
                            reply: {
                                id: request.id,
                                ok: true,
                                protocolVersion: 1,
                                result,
                            },
                            type: 'reply',
                        })}\n`,
                    );
                }
                newline = source.indexOf('\n');
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, () => resolve());
    });
    await chmod(endpoint, 0o600);
    const writeManifest = async (value: LegacyManifest): Promise<void> => {
        await writeFile(manifestPath, `${JSON.stringify({ manifestVersion: 1, ...value })}\n`, {
            mode: 0o600,
        });
        await chmod(manifestPath, 0o600);
    };
    await writeManifest(manifest);

    return {
        frames,
        manifest,
        userDataPath,
        writeManifest,
        async close(): Promise<void> {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('LegacyV1HostControl', () => {
    it('uses the fixed v1 operator handshake and only sends status and stop commands', async () => {
        const host = await startScriptedHost();
        const control = await LegacyV1HostControl.connect(host.userDataPath, 250);

        await expect(control.status()).resolves.toMatchObject({
            profileId: host.manifest.profileId,
            protocolVersion: 1,
        });
        await expect(control.stop(true)).resolves.toBeUndefined();

        const statusRequestId = commandRequestId(host.frames[1]);
        const stopRequestId = commandRequestId(host.frames[2]);
        expect(host.frames).toEqual([
            {
                credential: { kind: 'operator', token: operatorToken },
                profileId: host.manifest.profileId,
                supportedVersions: [1],
                type: 'hello',
            },
            {
                request: {
                    id: statusRequestId,
                    method: 'host.status',
                    params: {},
                    protocolVersion: 1,
                },
                type: 'command',
            },
            {
                request: {
                    id: stopRequestId,
                    method: 'host.stop',
                    params: { confirmLivePtys: true },
                    protocolVersion: 1,
                },
                type: 'command',
            },
        ]);
        control.close();
        await host.close();
    });

    it.each([
        ['a replaced profile identity', { profileId: 'another-profile' }, 'CONFLICT'],
        ['a replaced process identity', { processIdentity: 'c'.repeat(32) }, 'CONFLICT'],
        ['a non-v1 protocol version', { protocolVersion: 2 }, 'VALIDATION'],
        ['missing host.stop capability', { capabilities: ['host.read'] }, 'FORBIDDEN'],
        ['missing host.stop command', { commands: ['host.status'] }, 'FORBIDDEN'],
    ])('rejects %s during the authenticated welcome', async (_label, welcome, code) => {
        const host = await startScriptedHost({ welcome });

        await expect(LegacyV1HostControl.connect(host.userDataPath, 250)).rejects.toMatchObject({
            code,
        });
        await host.close();
    });

    it('rejects a manifest that is not protocol v1 before connecting', async () => {
        const host = await startScriptedHost();
        await host.writeManifest({ ...host.manifest, protocolVersion: 2 });

        await expect(LegacyV1HostControl.connect(host.userDataPath, 250)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(host.frames).toEqual([]);
        await host.close();
    });

    it('re-reads the manifest before stop and rejects a replacement', async () => {
        const host = await startScriptedHost();
        const control = await LegacyV1HostControl.connect(host.userDataPath, 250);
        await host.writeManifest({ ...host.manifest, processIdentity: 'c'.repeat(32) });

        await expect(control.stop(false)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(host.frames).toHaveLength(1);
        control.close();
        await host.close();
    });

    it('waits for only the original manifest identity to disappear within its bound', async () => {
        const host = await startScriptedHost();
        const control = await LegacyV1HostControl.connect(host.userDataPath, 250);
        await unlink(join(host.userDataPath, 'host', 'manifest.json'));

        await expect(control.waitForRelease()).resolves.toBeUndefined();
        control.close();
        await host.close();
    });

    it('fails closed for a replacement and times out when the original v1 manifest remains', async () => {
        const replaced = await startScriptedHost();
        const replacementControl = await LegacyV1HostControl.connect(replaced.userDataPath, 40);
        await replaced.writeManifest({ ...replaced.manifest, processIdentity: 'c'.repeat(32) });
        await expect(replacementControl.waitForRelease()).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        replacementControl.close();
        await replaced.close();

        const unchanged = await startScriptedHost();
        const timeoutControl = await LegacyV1HostControl.connect(unchanged.userDataPath, 40);
        await expect(timeoutControl.waitForRelease()).rejects.toMatchObject({ code: 'TIMEOUT' });
        timeoutControl.close();
        await unchanged.close();
    });
});
