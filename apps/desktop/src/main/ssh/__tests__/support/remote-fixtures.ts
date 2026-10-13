import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import type { RemoteLayerDescriptor } from '../../remote-layers';
import { shellQuote } from '../../shell-quote';
import type { SshExecOptions, SshExecResult } from '../../ssh-connection';

const execFileAsync = promisify(execFile);

/**
 * Short temp roots: Unix socket paths built inside them must fit the 104-byte macOS `sun_path`.
 */
export async function makeShortTemporaryDirectory(prefix: string): Promise<string> {
    return realpath(await mkdtemp(join('/tmp', `cxs-${prefix}-`)));
}

export function sha256(content: Buffer | string): string {
    return createHash('sha256').update(content).digest('hex');
}

/**
 * Writes executable stand-ins (for `uname`, `getconf`, `curl`) into a directory placed first on `PATH`.
 */
export async function writeShims(directory: string, shims: Record<string, string>): Promise<void> {
    await mkdir(directory, { recursive: true });
    await Promise.all(
        Object.entries(shims).map(async ([name, body]) => {
            const path = join(directory, name);
            await writeFile(path, `#!/bin/sh\n${body}\n`);
            await chmod(path, 0o755);
        }),
    );
}

/**
 * `uname`/`getconf` that make a macOS test machine look like the given Linux SSH Host to the probe script, and a `curl`
 * that always fails so the runtime is uploaded rather than fetched from the internet.
 */
export function linuxShims(
    options: { arch?: string; glibc?: string; os?: string } = {},
): Record<string, string> {
    return {
        curl: 'exit 22',
        getconf: `[ "$1" = GNU_LIBC_VERSION ] && echo "glibc ${options.glibc ?? '2.36'}"`,
        uname: `case "$1" in -s) echo ${options.os ?? 'Linux'} ;; -m) echo ${options.arch ?? 'x86_64'} ;; -n) echo test-host ;; *) echo ${options.os ?? 'Linux'} ;; esac`,
        wget: 'exit 1',
    };
}

/**
 * Runs a remote script with the local `/bin/sh`, standing in for the SSH Host.
 */
export async function runLocalScript(
    script: string,
    environment: NodeJS.ProcessEnv,
    stdin?: Readable | Buffer,
): Promise<SshExecResult> {
    const child = spawn('/bin/sh', ['-c', script], {
        env: environment,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (!child.stdout || !child.stderr) throw new Error('Script output pipes are missing');
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    if (stdin && child.stdin) {
        child.stdin.on('error', () => {});
        if (Buffer.isBuffer(stdin)) child.stdin.end(stdin);
        else stdin.pipe(child.stdin);
    }
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
    return {
        code,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
    };
}

/**
 * Environment of a fake SSH Host: an isolated `HOME` and the shims first on `PATH`.
 */
export function hostEnvironment(home: string, shimDirectory: string): NodeJS.ProcessEnv {
    return {
        HOME: home,
        LANG: 'C',
        PATH: `${shimDirectory}:/usr/bin:/bin:/usr/sbin:/sbin`,
        SSH_CONNECTION: '203.0.113.1 50000 203.0.113.2 22',
        NODE_OPTIONS: '--max-old-space-size=64',
        NODE_PATH: '/opt/node-path',
    };
}

/**
 * A stand-in Server: writes valid discovery files into its profile, records the environment it was started with, then
 * `exec`s an idle Node process so the recorded pid stays the live process. The idle process carries
 * `<build>/bundles/server-core.js` in its argv because on Linux the scripts identify a Server pid and its build from
 * `/proc/<pid>/cmdline`, exactly as they would for the real `runtime/bin/node .../bundles/server-core.js`.
 */
function fakeServerScript(remotePort: number): string {
    return String.raw`#!/bin/sh
build=$(cd "$(dirname "$0")/.." && pwd)
host="$CAXRI_USER_DATA_PATH/host"
mkdir -p "$host"
chmod 700 "$host"
identity=$(printf '%032x' $$)
token=$(printf '%064x' $$)
started=$(date +%s)000
env > "$CAXRI_USER_DATA_PATH/launch-environment.txt"
printf '{"credentialVersion":1,"profileId":"remote-profile","processIdentity":"%s","desktopToken":"%s"}\n' "$identity" "$token" > "$host/desktop-credential.json"
printf '{"manifestVersion":2,"profileId":"remote-profile","pid":%s,"startedAt":%s,"processIdentity":"%s","protocolVersion":2,"version":"0.0.1","operatorToken":"%s","endpoint":{"protocol":"ws","host":"127.0.0.1","port":${remotePort},"path":"/control"}}\n' $$ "$started" "$identity" "$token" > "$host/manifest.json"
exec ${shellQuote(process.execPath)} -e 'setTimeout(() => {}, 300000)' -- "$build/bundles/server-core.js"
`;
}

export interface LayerFixture {
    descriptor: RemoteLayerDescriptor;
    /**
     * Fake `node` binary content; its hash is the runtime cache key.
     */
    runtimeContent: Buffer;
    stagingDirectory: string;
}

/**
 * Builds `<root>/linux-<arch>/{descriptor.json,app.tar.gz}` the way the Server build does: no runtime binary in the
 * tarball and a top-level `SHA256SUMS` covering every file.
 */
export async function buildLayerFixture(
    root: string,
    options: {
        architecture?: 'arm64' | 'x64';
        buildId?: string;
        extraFiles?: Record<string, string>;
        remotePort?: number;
    } = {},
): Promise<LayerFixture> {
    const architecture = options.architecture ?? 'x64';
    const directory = join(root, `linux-${architecture}`);
    const staging = join(root, `staging-${architecture}`);
    const files: Record<string, string> = {
        'bundles/server-core.js': 'console.log("server");\n',
        'cli/caxri.cjs': 'module.exports = {};\n',
        'runtime/caxri-server': fakeServerScript(options.remotePort ?? 45_678),
        ...options.extraFiles,
    };
    const sums: string[] = [];
    for (const [path, content] of Object.entries(files)) {
        const target = join(staging, path);
        // eslint-disable-next-line no-await-in-loop -- tiny fixture tree.
        await mkdir(join(target, '..'), { recursive: true });
        // eslint-disable-next-line no-await-in-loop -- tiny fixture tree.
        await writeFile(target, content, { mode: path.startsWith('runtime/') ? 0o755 : 0o644 });
        sums.push(`${sha256(content)}  ${path}`);
    }
    await writeFile(join(staging, 'SHA256SUMS'), `${sums.join('\n')}\n`);
    await mkdir(directory, { recursive: true });
    const appPath = join(directory, 'app.tar.gz');
    await execFileAsync('tar', ['-czf', appPath, '-C', staging, '.']);
    const app = await readFile(appPath);
    const runtimeContent = Buffer.from(`#!/bin/sh\necho fake-node-${architecture}\n`);
    const descriptor: RemoteLayerDescriptor = {
        schemaVersion: 1,
        target: `linux-${architecture}`,
        buildId: options.buildId ?? '0123456789abcdef',
        fingerprint: 'fixture-fingerprint',
        version: '0.0.1',
        commit: 'fixture',
        glibcBaseline: '2.28',
        app: { file: 'app.tar.gz', sha256: sha256(app), bytes: app.length },
        runtime: {
            sha256: sha256(runtimeContent),
            bytes: runtimeContent.length,
            path: 'runtime/bin/node',
            source: {
                url: `https://nodejs.org/dist/v0.0.0/node-v0.0.0-linux-${architecture}.tar.gz`,
                sha256: sha256('archive-not-used'),
                member: `node-v0.0.0-linux-${architecture}/bin/node`,
            },
        },
    };
    await writeFile(join(directory, 'descriptor.json'), JSON.stringify(descriptor));
    return { descriptor, runtimeContent, stagingDirectory: staging };
}

/**
 * Fake transport that runs every remote script with the local `/bin/sh` against a temporary `HOME`.
 */
export class LocalTransport {
    private readonly closeListeners = new Set<
        (info: { code: number | null; message: string; signal: NodeJS.Signals | null }) => void
    >();

    isOpen = false;
    readonly execs: string[] = [];
    readonly forwards: number[] = [];

    constructor(
        private readonly environment: NodeJS.ProcessEnv,
        private readonly startFailure?: Error,
    ) {}

    start(): Promise<void> {
        if (this.startFailure) return Promise.reject(this.startFailure);
        this.isOpen = true;
        return Promise.resolve();
    }

    async exec(script: string, options: SshExecOptions): Promise<SshExecResult> {
        this.execs.push(script);
        return runLocalScript(script, this.environment, options.stdin);
    }

    forwardLocal(remotePort: number): Promise<number> {
        this.forwards.push(remotePort);
        return Promise.resolve(remotePort + 1000);
    }

    cancelForward(): Promise<void> {
        return Promise.resolve();
    }

    onClose(
        listener: (info: {
            code: number | null;
            message: string;
            signal: NodeJS.Signals | null;
        }) => void,
    ): () => void {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    /**
     * Simulates the ControlMaster dying (network loss).
     */
    drop(): void {
        this.isOpen = false;
        for (const listener of this.closeListeners)
            listener({
                code: 255,
                message: 'Connection to host closed by remote host.',
                signal: null,
            });
    }

    stop(): Promise<void> {
        this.isOpen = false;
        return Promise.resolve();
    }
}

/**
 * Kills a fake Server started by a launch script, ignoring one that already exited.
 */
export async function killRemoteServer(home: string): Promise<void> {
    try {
        const manifest = JSON.parse(
            await readFile(join(home, '.caxri-server/profile/host/manifest.json'), 'utf8'),
        ) as { pid: number };
        process.kill(manifest.pid, 'SIGKILL');
    } catch {
        // Nothing was started, or it already exited.
    }
}

/**
 * Resolves with the rejection reason so a test can assert on the error object itself.
 */
export async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('Expected the promise to reject');
}
