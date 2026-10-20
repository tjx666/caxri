/**
 * Disposable `sshd` container standing in for an SSH Host: a Debian bookworm account `dev` with no Node, reached with a
 * generated key and its own `ssh_config`, so the developer's `~/.ssh` is never read or written. The opt-in SSH
 * integration suites and the Server footprint benchmark (`docs/server-footprint.md`) run against it.
 *
 *     bun run scripts/ssh-lab.ts up [--name caxri-ssh-lab] [--port 2222]   # prints CAXRI_SSH_CONFIG and destination
 *     bun run scripts/ssh-lab.ts down [--name caxri-ssh-lab]
 *
 * The key is installed after `docker run` instead of being baked into the image, so the image stays generic and a fresh
 * container never trusts a key from an earlier lab.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { execFileAsync } from './exec';

const IMAGE = 'caxri-ssh-lab-base:bookworm';
const DESTINATION = 'caxri-lab';

/**
 * The tools `host-requirements` probes for, plus `procps` and `git` so a benchmark can read `/proc` sizes and build a
 * Git Project. `xz-utils` lets the remote installer download Node directly, as on a typical cloud host.
 */
const DOCKERFILE = String.raw`FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server bash curl ca-certificates xz-utils procps git \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    && useradd -m -s /bin/bash dev \
    && install -d -m 700 -o dev -g dev /home/dev/.ssh
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
`;

export interface SshLab {
    configFile: string;
    container: string;
    destination: string;
    directory: string;
}

/**
 * Short and under `/tmp`: OpenSSH control sockets created beside it must fit the 104-byte macOS `sun_path`. The name
 * must be a plain Docker container name: the directory is removed recursively, so `..` or an empty name must never
 * resolve to `/` or `/tmp`.
 */
function labDirectory(name: string): string {
    if (!/^[a-z0-9][\w.-]*$/i.test(name))
        throw new Error(`Invalid lab name "${name}": use letters, digits, ".", "_", and "-"`);
    return join('/tmp', name);
}

async function docker(argv: string[], options: { input?: string } = {}): Promise<string> {
    const pending = execFileAsync('docker', argv);
    pending.child.stdin?.end(options.input);
    return (await pending).stdout;
}

async function waitForSsh(configFile: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
        try {
            // eslint-disable-next-line no-await-in-loop -- bounded readiness polling
            await execFileAsync('ssh', [
                '-F',
                configFile,
                '-o',
                'BatchMode=yes',
                DESTINATION,
                'true',
            ]);
            return;
        } catch (error) {
            if (Date.now() > deadline) throw error;
            // eslint-disable-next-line no-await-in-loop -- bounded readiness polling
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
}

async function removeContainer(name: string): Promise<void> {
    try {
        await docker(['rm', '--force', name]);
    } catch {
        // Nothing to remove.
    }
}

/**
 * Authorizes a fresh key in the running container and writes the `ssh_config` that reaches it.
 */
async function provisionSshLab(name: string, port: number, directory: string): Promise<SshLab> {
    const key = join(directory, 'id_ed25519');
    await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', key]);
    const publicKey = await readFile(`${key}.pub`, 'utf8');
    await docker(
        [
            'exec',
            '--interactive',
            '--user',
            'dev',
            name,
            'sh',
            '-c',
            'umask 077 && cat > /home/dev/.ssh/authorized_keys',
        ],
        { input: publicKey },
    );

    const configFile = join(directory, 'ssh_config');
    await writeFile(
        configFile,
        `Host ${DESTINATION}
    HostName 127.0.0.1
    Port ${port}
    User dev
    IdentityFile ${key}
    IdentitiesOnly yes
    UserKnownHostsFile ${join(directory, 'known_hosts')}
    StrictHostKeyChecking accept-new
`,
    );
    await waitForSsh(configFile);
    return { configFile, container: name, destination: DESTINATION, directory };
}

/**
 * Starts a fresh lab container, replacing any container of the same name, and returns how to reach it. A failure after
 * `docker run` removes the container and directory again, so a failed start leaves nothing running.
 */
export async function startSshLab(name: string, port: number): Promise<SshLab> {
    const directory = labDirectory(name);
    await rm(directory, { force: true, recursive: true });
    await mkdir(join(directory, 'image'), { recursive: true });
    await writeFile(join(directory, 'image', 'Dockerfile'), DOCKERFILE);
    await docker(['build', '--quiet', '--tag', IMAGE, join(directory, 'image')]);
    await removeContainer(name);
    try {
        await docker([
            'run',
            '--detach',
            '--name',
            name,
            '--publish',
            `127.0.0.1:${port}:22`,
            IMAGE,
        ]);
        return await provisionSshLab(name, port, directory);
    } catch (error) {
        await stopSshLab(name);
        throw error;
    }
}

export async function stopSshLab(name: string): Promise<void> {
    await removeContainer(name);
    await rm(labDirectory(name), { force: true, recursive: true });
}

if (import.meta.main) {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            name: { type: 'string', default: 'caxri-ssh-lab' },
            port: { type: 'string', default: '2222' },
        },
    });
    const [command] = positionals;
    if (command === 'up') {
        const lab = await startSshLab(values.name, Number(values.port));
        console.log(`CAXRI_SSH_CONFIG=${lab.configFile} CAXRI_SSH_DESTINATION=${lab.destination}`);
    } else if (command === 'down') {
        await stopSshLab(values.name);
    } else {
        console.error(
            'Usage: bun run scripts/ssh-lab.ts up|down [--name <container>] [--port <port>]',
        );
        process.exitCode = 2;
    }
}
