import { Buffer } from 'node:buffer';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AskpassBridge } from '../askpass';
import { parseSshDestination } from '../destination';
import type { SshConnectionOptions } from '../ssh-connection';
import {
    classifySshFailure,
    remoteShellCommand,
    SshConnection,
    SshConnectionError,
} from '../ssh-connection';
import { writeFakeSsh } from './support/fake-ssh';
import { captureRejection, makeShortTemporaryDirectory } from './support/fixtures';

describe('ssh connection', () => {
    let root: string;
    let state: string;
    let sshExecutable: string;
    const connections: SshConnection[] = [];

    beforeEach(async () => {
        root = await makeShortTemporaryDirectory('con');
        state = join(root, 'state');
        await mkdir(state);
        sshExecutable = await writeFakeSsh(root);
    });

    afterEach(async () => {
        const owned = connections.slice();
        connections.length = 0;
        await Promise.all(owned.map((connection) => connection.stop()));
        await rm(root, { force: true, recursive: true });
    });

    function connect(
        mode: string,
        extra: Partial<SshConnectionOptions> & { variables?: Record<string, string> } = {},
    ): SshConnection {
        const { variables, ...overrides } = extra;
        const connection = new SshConnection({
            configFile: join(root, 'ssh_config'),
            controlDirectory: join(root, 'ctl'),
            destination: parseSshDestination('dev@lab:2222'),
            environment: { FAKE_SSH_MODE: mode, FAKE_SSH_STATE: state, ...variables },
            readyPollIntervalMs: 20,
            sshExecutable,
            ...overrides,
        });
        connections.push(connection);
        return connection;
    }

    async function calls(): Promise<string[][]> {
        const text = await readFile(join(state, 'calls.jsonl'), 'utf8');
        return text
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as string[]);
    }

    async function isPresent(path: string): Promise<boolean> {
        try {
            await lstat(path);
            return true;
        } catch {
            return false;
        }
    }

    describe('classifySshFailure', () => {
        it.each([
            ['Host key verification failed.', 'hostKey'],
            ['WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', 'hostKey'],
            ['dev@lab: Permission denied (publickey).', 'authentication'],
            ['ssh: connect to host lab port 22: Connection refused', 'unreachable'],
            ['kex_exchange_identification: read: Connection reset by peer', 'unreachable'],
            ['something odd', 'unknown'],
        ])('classifies %j', (stderr, reason) => {
            expect(classifySshFailure(`debug1: noise\n${stderr}\n\n`)).toEqual({
                message: stderr,
                reason,
            });
        });
    });

    describe('remoteShellCommand', () => {
        it('wraps the script in a login-shell-neutral base64 eval', () => {
            const command = remoteShellCommand("echo 'hi' $HOME");
            expect(command).toMatch(/^sh -c 'eval "\$\(echo [A-Za-z0-9+/=]+ \| base64 -d\)"'$/u);
            expect(() => remoteShellCommand('x'.repeat(200 * 1024))).toThrow(/too large/u);
        });
    });

    describe('SshConnection', () => {
        it('starts a master, runs scripts with stdin, and stops without a close notification', async () => {
            const connection = connect('ok');
            let closes = 0;
            connection.onClose(() => {
                closes += 1;
            });
            await connection.start();
            expect(connection.isOpen).toBe(true);
            expect((await lstat(join(root, 'ctl'))).mode & 0o777).toBe(0o700);

            const echoed = await connection.exec(
                'read line; printf "%s|%s" "$line" "$0" >&1; echo err >&2; exit 3',
                {
                    stdin: Readable.from([Buffer.from('from stdin\n')]),
                    timeoutMs: 5000,
                },
            );
            expect(echoed).toEqual({ code: 3, stderr: 'err\n', stdout: 'from stdin|sh' });

            const list = await calls();
            const [master, client] = [
                list.find((argv) => argv.includes('-M')) ?? [],
                list.findLast((argv) => !argv.includes('-M') && !argv.includes('-O')) ?? [],
            ];
            expect(master.slice(0, 2)).toEqual(['-F', join(root, 'ssh_config')]);
            expect(master).toContain('ClearAllForwardings=yes');
            expect(master).toContain('ControlPersist=no');
            expect(master.slice(-6)).toEqual(['-p', '2222', '-l', 'dev', '--', 'lab']);
            expect(client).toContain('BatchMode=yes');
            expect(client).toContain('ControlMaster=no');
            expect(client.slice(-3, -1)).toEqual(['--', 'lab']);

            await connection.stop();
            expect(connection.isOpen).toBe(false);
            expect(await isPresent(connection.controlPath)).toBe(false);
            expect(closes).toBe(0);
            await expect(connection.exec('true', { timeoutMs: 1000 })).rejects.toMatchObject({
                reason: 'connectionLost',
            });
        });

        it.each([
            ['auth', 'authentication', /^dev@lab: Permission denied \(publickey,password\)\.$/u],
            ['hostkey', 'hostKey', /^Host key verification failed\.$/u],
            ['unreachable', 'unreachable', /Could not resolve hostname/u],
        ])('classifies a %s failure', async (mode, reason, message) => {
            const error = await captureRejection(connect(mode).start());
            expect(error).toBeInstanceOf(SshConnectionError);
            expect(error).toMatchObject({ reason });
            expect((error as SshConnectionError).message).toMatch(message);
        });

        it('gives up when the master never becomes ready', async () => {
            const connection = connect('hang', { readyTimeoutMs: 300 });
            await expect(connection.start()).rejects.toMatchObject({ reason: 'unreachable' });
            expect(connection.isOpen).toBe(false);
        });

        it('notifies when an established master dies', async () => {
            const connection = connect('die', { variables: { FAKE_SSH_DIE_MS: '400' } });
            const closed = new Promise<{ code: number | null; message: string }>((resolve) =>
                connection.onClose(resolve),
            );
            await connection.start();
            const info = await closed;
            expect(info).toMatchObject({
                code: 255,
                message: 'Connection to lab closed by remote host.',
            });
            expect(connection.isOpen).toBe(false);
        });

        it('kills a command that outlives its timeout', async () => {
            const connection = connect('ok');
            await connection.start();
            await expect(connection.exec('sleep 5', { timeoutMs: 200 })).rejects.toMatchObject({
                code: 'TIMEOUT',
            });
        });

        it('refuses output beyond the cap', async () => {
            const connection = connect('ok');
            await connection.start();
            await expect(
                connection.exec('head -c 70000 /dev/zero', {
                    maxOutputBytes: 1024,
                    timeoutMs: 5000,
                }),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
        });

        it('retries a forward whose port was taken and cancels it', async () => {
            const connection = connect('ok', { variables: { FAKE_SSH_FORWARD_FAILURES: '2' } });
            await connection.start();
            const localPort = await connection.forwardLocal(45_678);
            expect(localPort).toBeGreaterThan(0);
            await connection.cancelForward(localPort);
            const forwards = (await calls()).filter((argv) => argv.includes('forward'));
            expect(forwards).toHaveLength(3);
            expect(forwards.at(-1)).toContain(`127.0.0.1:${localPort}:127.0.0.1:45678`);
            const cancels = (await calls()).filter((argv) => argv.includes('cancel'));
            expect(cancels).toHaveLength(1);
        });

        it('keeps a sibling master and closes one orphaned by a dead Main', async () => {
            const first = connect('ok');
            await first.start();
            // A socket left by a Main that exited without stopping its master; pid 999999 is not running.
            const orphanPath = join(root, 'ctl', '0123456789ab.999999.0a0b0c0d');
            const orphan = createServer();
            await new Promise<void>((resolve) => orphan.listen(orphanPath, resolve));
            const second = connect('ok', { variables: { FAKE_SSH_STATE: join(root, 'second') } });
            await mkdir(join(root, 'second'));
            await second.start();
            expect(second.controlPath).not.toBe(first.controlPath);
            expect(first.isOpen).toBe(true);
            expect(second.isOpen).toBe(true);
            expect(await isPresent(orphanPath)).toBe(false);
            const exits = (await readFile(join(root, 'second', 'calls.jsonl'), 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as string[])
                .filter((argv) => argv.includes('exit'));
            expect(exits).toEqual([expect.arrayContaining([`ControlPath=${orphanPath}`])]);
            await new Promise<void>((resolve) => orphan.close(() => resolve()));
        });

        it('answers OpenSSH prompts through the askpass bridge', async () => {
            const prompts: string[] = [];
            const bridge = await AskpassBridge.create({
                directory: join(root, 'ask'),
                electronExecutable: process.execPath,
                handler: (request) => {
                    prompts.push(request.prompt);
                    return Promise.resolve(prompts.length === 1 ? 'wrong' : 'open sesame');
                },
            });
            try {
                await expect(
                    connect('askpass', {
                        environment: {
                            ...bridge.environment(),
                            FAKE_SSH_MODE: 'askpass',
                            FAKE_SSH_STATE: state,
                        },
                    }).start(),
                ).rejects.toMatchObject({ reason: 'authentication' });
                const connection = connect('askpass', {
                    environment: {
                        ...bridge.environment(),
                        FAKE_SSH_MODE: 'askpass',
                        FAKE_SSH_STATE: state,
                    },
                });
                await connection.start();
                expect(connection.isOpen).toBe(true);
                expect(prompts).toEqual(["dev@lab's password: ", "dev@lab's password: "]);
            } finally {
                await bridge.close();
            }
        });
    });
});
