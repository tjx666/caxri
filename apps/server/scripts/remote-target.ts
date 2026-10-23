import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    cp,
    lstat,
    mkdir,
    open,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const runtimeCacheRoot = resolve(root, '.cache/server-remote-target/runtime');

/**
 * Every system an SSH Host Server is assembled for, named `<platform>-<architecture>` like the Node.js release
 * tarballs. Linux targets cross-assemble their natives in a manylinux container (`linux-target.ts`); `darwin-arm64`
 * reuses the build host's natives, so only an Apple silicon Mac can assemble it.
 */
const REMOTE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64'] as const;
export type RemoteTarget = (typeof REMOTE_TARGETS)[number];

/**
 * Oldest macOS a `darwin-arm64` SSH Host may run: the Node.js 24 floor. Checked on every build against each shipped
 * Mach-O file's minimum version so a native addon cannot silently raise it above what `docs/ssh-host.md` documents.
 */
export const MACOS_BASELINE = '13.5';

/**
 * Whether this machine can assemble `darwin-arm64`, whose natives come from the host's own install.
 */
function canAssembleDarwinTarget(
    host: { arch: string; platform: NodeJS.Platform } = process,
): boolean {
    return host.platform === 'darwin' && host.arch === 'arm64';
}

/**
 * Parses `--target <target>` values. Without one it returns both Linux targets plus `darwin-arm64` when this host can
 * assemble it.
 */
export function parseRemoteTargets(
    argv: readonly string[],
    host: { arch: string; platform: NodeJS.Platform } = process,
): RemoteTarget[] {
    const values = argv.flatMap((value, index) => (argv[index - 1] === '--target' ? [value] : []));
    if (values.length === 0)
        return REMOTE_TARGETS.filter(
            (target) => target !== 'darwin-arm64' || canAssembleDarwinTarget(host),
        );
    return values.map((value) => {
        if (!(REMOTE_TARGETS as readonly string[]).includes(value))
            throw new Error(`Unsupported --target ${value}; expected ${REMOTE_TARGETS.join(', ')}`);
        if (value === 'darwin-arm64' && !canAssembleDarwinTarget(host))
            throw new Error('--target darwin-arm64 needs an Apple silicon Mac build host');
        return value as RemoteTarget;
    });
}

export interface NodeRuntimeSource {
    /**
     * Official Node.js tarball URL; an SSH Host downloads it directly when it has network access.
     */
    url: string;
    sha256: string;
    /**
     * Path of the `node` binary inside the tarball.
     */
    member: string;
    /**
     * Local cached copy of the tarball, uploaded when the SSH Host cannot reach nodejs.org itself.
     */
    tarballPath: string;
}

/**
 * Locates the LICENSE at the root of the Node installation that owns a host runtime executable. Resolving links first
 * keeps a mise or package-manager shim from selecting an unrelated license beside the shim itself.
 */
export async function resolveHostNodeLicense(executable: string): Promise<string> {
    const resolvedExecutable = await realpath(executable);
    return resolve(dirname(resolvedExecutable), '..', 'LICENSE');
}

export async function hasPath(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
    }
}

export async function download(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    return Buffer.from(await response.arrayBuffer());
}

async function writeAtomically(path: string, contents: Buffer | string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, contents);
    await rename(temporary, path);
}

export function sha256(contents: Buffer | string): string {
    return createHash('sha256').update(contents).digest('hex');
}

/**
 * Downloads the official Node.js tarball for a target once and verifies it against the release's published SHASUMS256.
 */
export async function ensureNodeRuntime(
    target: RemoteTarget,
    version: string,
): Promise<NodeRuntimeSource> {
    // gzip rather than xz: an SSH Host fetches this tarball itself, and slim images often lack `xz`.
    const name = `node-v${version}-${target}.tar.gz`;
    const url = `https://nodejs.org/dist/v${version}/${name}`;
    const member = `node-v${version}-${target}/bin/node`;
    const tarballPath = join(runtimeCacheRoot, name);
    const checksumPath = `${tarballPath}.sha256`;
    if ((await hasPath(tarballPath)) && (await hasPath(checksumPath))) {
        const expected = (await readFile(checksumPath, 'utf8')).trim();
        if (sha256(await readFile(tarballPath)) === expected)
            return { url, sha256: expected, member, tarballPath };
    }
    const checksums = (
        await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)
    ).toString('utf8');
    const expected = checksums
        .split('\n')
        .map((line) => line.trim().split(/\s+/u))
        .find(([, file]) => file === name)?.[0];
    if (!expected || !/^[\da-f]{64}$/u.test(expected))
        throw new Error(`SHASUMS256.txt has no entry for ${name}`);
    const tarball = await download(url);
    if (sha256(tarball) !== expected) throw new Error(`Checksum mismatch for ${name}`);
    await writeAtomically(tarballPath, tarball);
    await writeAtomically(checksumPath, `${expected}\n`);
    return { url, sha256: expected, member, tarballPath };
}

/**
 * Extracts the `node` binary and its top-level LICENSE from the same verified official runtime tarball. The optional
 * extraction root lets focused tests isolate their cache without changing production behavior.
 */
export async function extractNodeRuntime(
    source: NodeRuntimeSource,
    destination: string,
    extractionRoot = runtimeCacheRoot,
): Promise<string> {
    const memberMatch = /^([^/]+)\/bin\/node$/u.exec(source.member);
    if (!memberMatch) throw new Error(`Invalid Node runtime member: ${source.member}`);
    if (sha256(await readFile(source.tarballPath)) !== source.sha256)
        throw new Error(`Runtime tarball checksum no longer matches ${source.sha256}`);
    const licenseMember = `${memberMatch[1]}/LICENSE`;
    const directory = join(extractionRoot, `${source.sha256}-extract`);
    const extracted = join(directory, source.member);
    const extractedLicense = join(directory, licenseMember);
    if (!(await hasPath(extracted)) || !(await hasPath(extractedLicense))) {
        await rm(directory, { force: true, recursive: true });
        await mkdir(directory, { recursive: true });
        await execFileAsync('tar', [
            '-xzf',
            source.tarballPath,
            '-C',
            directory,
            source.member,
            licenseMember,
        ]);
    }
    const [runtimeMetadata, licenseMetadata] = await Promise.all([
        lstat(extracted),
        lstat(extractedLicense),
    ]);
    if (!runtimeMetadata.isFile() || runtimeMetadata.isSymbolicLink())
        throw new Error(`Extracted Node runtime is not a regular file: ${source.member}`);
    if (!licenseMetadata.isFile() || licenseMetadata.isSymbolicLink())
        throw new Error(`Extracted Node runtime license is not a regular file: ${licenseMember}`);
    await mkdir(dirname(destination), { recursive: true });
    await cp(extracted, destination);
    return extractedLicense;
}

/**
 * Reads the Node.js version mise pins; the Server runtime and every remote target follow it.
 */
export async function pinnedRuntimeVersion(): Promise<string> {
    const miseSource = await readFile(resolve(root, 'mise.toml'), 'utf8');
    const version = /^node\s*=\s*"([^"]+)"$/mu.exec(miseSource)?.[1];
    if (!version) throw new Error('mise.toml must pin the Server runtime version');
    return version;
}

/**
 * Reads the minimum macOS version a Mach-O file declares (`LC_BUILD_VERSION`'s `minos`, or the older
 * `LC_VERSION_MIN_MACOSX`'s `version`), or `undefined` for a file that is not Mach-O.
 */
async function machOMinimumMacos(path: string): Promise<string | undefined> {
    const header = Buffer.alloc(4);
    const handle = await open(path, 'r');
    try {
        await handle.read(header, 0, 4, 0);
    } finally {
        await handle.close();
    }
    const magic = header.readUInt32BE(0);
    // 64-bit Mach-O in either byte order, or a universal (fat) binary.
    if (![0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) return undefined;
    const { stdout } = await execFileAsync('otool', ['-l', path], { maxBuffer: 16 * 1024 * 1024 });
    // Each architecture slice lists its load commands; only the macOS build-version ones carry the floor. A plain
    // `version` line also appears for linker tools and source versions, so the block's command decides which line counts.
    const versions = stdout.split(/^Load command \d+$/mu).flatMap((block) => {
        const command = /^\s*cmd (\S+)$/mu.exec(block)?.[1];
        if (command === 'LC_BUILD_VERSION' && /^\s*platform 1$/mu.test(block))
            return [/^\s*minos (\d+(?:\.\d+)*)$/mu.exec(block)?.[1] ?? '0'];
        if (command === 'LC_VERSION_MIN_MACOSX')
            return [/^\s*version (\d+(?:\.\d+)*)$/mu.exec(block)?.[1] ?? '0'];
        return [];
    });
    return versions.toSorted((left, right) => compareDottedVersions(right, left))[0];
}

function compareDottedVersions(left: string, right: string): number {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

async function listFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Fails when any Mach-O file in an assembled `darwin-arm64` artifact requires a newer macOS than `MACOS_BASELINE`.
 */
export async function assertMacosBaseline(artifactRoot: string): Promise<void> {
    const files = await listFiles(artifactRoot);
    const minimums = await Promise.all(
        files.map(async (path) => ({ path, minimum: await machOMinimumMacos(path) })),
    );
    const above = minimums.filter(
        ({ minimum }) =>
            minimum !== undefined && compareDottedVersions(minimum, MACOS_BASELINE) > 0,
    );
    if (above.length > 0)
        throw new Error(
            `darwin-arm64 binaries require a macOS newer than the ${MACOS_BASELINE} baseline: ${above
                .map(({ path, minimum }) => `${path.slice(artifactRoot.length + 1)} (${minimum})`)
                .join(', ')}`,
        );
}
