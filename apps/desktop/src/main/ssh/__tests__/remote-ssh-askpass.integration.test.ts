import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AskpassBridge } from '../askpass';
import { parseSshDestination } from '../destination';
import { SshConnection, SshConnectionError } from '../ssh-connection';
import { makeShortTemporaryDirectory } from './support/remote-fixtures';
import { isSshIntegrationEnabled, labConfigFile, labDestination } from './support/ssh-lab';

const execFileAsync = promisify(execFile);

/**
 * Real OpenSSH prompts through the askpass bridge. The lab's identity is copied and re-encrypted with a passphrase, and
 * a fresh `known_hosts` with `StrictHostKeyChecking ask` makes OpenSSH ask about the host key first. The user's own SSH
 * files are never read: everything is derived from `ssh -G` against `CAXRI_SSH_CONFIG`. A destination behind a
 * `ProxyJump` keeps its jump host, so the prompts also cover a connection that traverses one.
 */
describe.skipIf(!isSshIntegrationEnabled)('remote SSH askpass (integration)', () => {
    const PASSPHRASE = 'integration passphrase';
    let root: string;
    let host: {
        hostName: string;
        identityFile: string;
        port: string;
        proxyJump?: string;
        user: string;
    };

    beforeAll(async () => {
        root = await makeShortTemporaryDirectory('askpass');
        const { stdout } = await execFileAsync('ssh', [
            ...(labConfigFile === undefined ? [] : ['-F', labConfigFile]),
            '-G',
            labDestination,
        ]);
        const options = new Map<string, string>();
        for (const line of stdout.split('\n')) {
            const separator = line.indexOf(' ');
            if (separator > 0 && !options.has(line.slice(0, separator)))
                options.set(line.slice(0, separator), line.slice(separator + 1));
        }
        host = {
            hostName: options.get('hostname') ?? '',
            identityFile: options.get('identityfile') ?? '',
            port: options.get('port') ?? '22',
            user: options.get('user') ?? '',
        };
        const proxyJump = options.get('proxyjump');
        if (proxyJump !== undefined && proxyJump !== 'none') host.proxyJump = proxyJump;
        const key = join(root, 'key');
        await writeFile(key, await readFile(host.identityFile), { mode: 0o600 });
        await execFileAsync('ssh-keygen', ['-q', '-p', '-P', '', '-N', PASSPHRASE, '-f', key]);
    }, 60_000);

    afterAll(async () => {
        if (root) await rm(root, { force: true, recursive: true });
    });

    async function writeConfig(name: string): Promise<string> {
        const path = join(root, `${name}.config`);
        await writeFile(
            path,
            [
                'Host askpass-lab',
                `  HostName ${host.hostName}`,
                `  Port ${host.port}`,
                `  User ${host.user}`,
                `  IdentityFile ${join(root, 'key')}`,
                '  IdentitiesOnly yes',
                '  PreferredAuthentications publickey',
                '  StrictHostKeyChecking ask',
                `  UserKnownHostsFile ${join(root, `${name}.known_hosts`)}`,
                // `ProxyJump` would resolve the jump alias against this generated file, which does not define it; the
                // equivalent `-W` hop resolves it against the lab config instead.
                ...(host.proxyJump === undefined
                    ? []
                    : [
                          `  ProxyCommand ssh ${labConfigFile === undefined ? '' : `-F '${labConfigFile}' `}-W %h:%p ${host.proxyJump}`,
                      ]),
                '',
            ].join('\n'),
        );
        return path;
    }

    async function connect(
        config: string,
        answer: (kind: string) => string | null,
    ): Promise<{ error?: unknown; kinds: string[]; ms: number }> {
        const kinds: string[] = [];
        const bridge = await AskpassBridge.create({
            directory: join(root, 'ctl'),
            electronExecutable: process.execPath,
            handler: (request) => {
                kinds.push(request.kind);
                return Promise.resolve(answer(request.kind));
            },
        });
        const connection = new SshConnection({
            configFile: config,
            controlDirectory: join(root, 'ctl'),
            destination: parseSshDestination('askpass-lab'),
            environment: bridge.environment(),
        });
        const startedAt = Date.now();
        let error: unknown;
        try {
            await connection.start();
            const { stdout } = await connection.exec('echo connected', { timeoutMs: 10_000 });
            expect(stdout).toContain('connected');
        } catch (error_) {
            error = error_;
        }
        const ms = Date.now() - startedAt;
        await connection.stop();
        await bridge.close();
        return { ms, kinds, ...(error !== undefined && { error }) };
    }

    it('asks to confirm a new host key, then for the key passphrase', async () => {
        const config = await writeConfig('accept');
        const result = await connect(config, (kind) => (kind === 'confirm' ? 'yes' : PASSPHRASE));
        expect(result.error).toBeUndefined();
        expect(result.kinds).toEqual(['confirm', 'secret']);
        // The accepted key was recorded, so the next connection only asks for the passphrase.
        const again = await connect(config, () => PASSPHRASE);
        expect(again.error).toBeUndefined();
        expect(again.kinds).toEqual(['secret']);
    }, 60_000);

    it('classifies a wrong passphrase as authentication', async () => {
        const config = await writeConfig('wrong');
        const result = await connect(config, (kind) => (kind === 'confirm' ? 'yes' : 'wrong'));
        expect(result.error).toBeInstanceOf(SshConnectionError);
        expect((result.error as SshConnectionError).reason).toBe('authentication');
        expect(result.kinds[0]).toBe('confirm');
        expect(result.kinds.slice(1).every((kind) => kind === 'secret')).toBe(true);
    }, 60_000);

    it('classifies a refused host key as hostKey', async () => {
        const config = await writeConfig('refuse');
        const result = await connect(config, () => null);
        expect(result.error).toBeInstanceOf(SshConnectionError);
        expect((result.error as SshConnectionError).reason).toBe('hostKey');
        expect(result.kinds).toEqual(['confirm']);
    }, 60_000);
});
