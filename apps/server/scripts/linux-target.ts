import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../..');
const serverRoot = resolve(import.meta.dirname, '..');
const cacheRoot = resolve(root, '.cache/server-linux-target');

export type LinuxArchitecture = 'arm64' | 'x64';

const linuxArchitectures: ReadonlySet<LinuxArchitecture> = new Set(['x64', 'arm64']);

/**
 * The manylinux 2.28 images build against glibc 2.28 with a toolchain that links newer libstdc++ symbols statically,
 * which is the same floor the official Node 24 Linux binaries require. Anything this host builds therefore runs
 * wherever the runtime itself runs.
 */
const MANYLINUX_IMAGES: Record<LinuxArchitecture, { image: string; platform: string }> = {
    x64: { image: 'quay.io/pypa/manylinux_2_28_x86_64', platform: 'linux/amd64' },
    arm64: { image: 'quay.io/pypa/manylinux_2_28_aarch64', platform: 'linux/arm64' },
};

/**
 * Highest glibc symbol version any shipped Linux binary may reference. Checked on every build so a toolchain or
 * dependency change cannot silently raise the SSH Host baseline documented in `docs/ssh-host.md`.
 */
export const LINUX_GLIBC_BASELINE = '2.28';

export interface LinuxRuntimeSource {
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

export interface LinuxNatives {
    betterSqlite: string;
    nodePty: string;
    watcherPackage: string;
}

/**
 * Locates the LICENSE at the root of the Node installation that owns a host runtime executable. Resolving links first
 * keeps a mise or package-manager shim from selecting an unrelated license beside the shim itself.
 */
export async function resolveHostNodeLicense(executable: string): Promise<string> {
    const resolvedExecutable = await realpath(executable);
    return resolve(dirname(resolvedExecutable), '..', 'LICENSE');
}

async function hasPath(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
    }
}

async function download(url: string): Promise<Buffer> {
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

function sha256(contents: Buffer | string): string {
    return createHash('sha256').update(contents).digest('hex');
}

/**
 * Downloads the official Node.js Linux tarball once and verifies it against the release's published SHASUMS256.
 */
export async function ensureLinuxRuntime(
    architecture: LinuxArchitecture,
    version: string,
): Promise<LinuxRuntimeSource> {
    // gzip rather than xz: an SSH Host fetches this tarball itself, and slim images often lack `xz`.
    const name = `node-v${version}-linux-${architecture}.tar.gz`;
    const url = `https://nodejs.org/dist/v${version}/${name}`;
    const tarballPath = join(cacheRoot, 'runtime', name);
    const checksumPath = `${tarballPath}.sha256`;
    if ((await hasPath(tarballPath)) && (await hasPath(checksumPath))) {
        const expected = (await readFile(checksumPath, 'utf8')).trim();
        if (sha256(await readFile(tarballPath)) === expected)
            return {
                url,
                sha256: expected,
                member: `node-v${version}-linux-${architecture}/bin/node`,
                tarballPath,
            };
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
    return {
        url,
        sha256: expected,
        member: `node-v${version}-linux-${architecture}/bin/node`,
        tarballPath,
    };
}

/**
 * Extracts the `node` binary and its top-level LICENSE from the same verified official runtime tarball. The optional
 * extraction root lets focused tests isolate their cache without changing production behavior.
 */
export async function extractLinuxNode(
    source: LinuxRuntimeSource,
    destination: string,
    extractionRoot = join(cacheRoot, 'runtime'),
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

function packageDirectory(name: string): string {
    return dirname(require.resolve(`${name}/package.json`, { paths: [serverRoot] }));
}

async function packageVersion(directory: string): Promise<string> {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        version: string;
    };
    return manifest.version;
}

/**
 * Copies a package with its symlinks dereferenced (pnpm's store is symlinked) plus `node-addon-api`, which both native
 * packages read through `binding.gyp` but pnpm keeps outside the package directory.
 */
async function stageNativeSource(name: string, destination: string): Promise<void> {
    const source = packageDirectory(name);
    await cp(source, destination, { recursive: true, dereference: true });
    await rm(join(destination, 'build'), { force: true, recursive: true });
    // better-sqlite3's binding.gyp skips compilation whenever a prebuild exists, and its glibc 2.34 prebuild is exactly
    // what this build replaces.
    await rm(join(destination, 'prebuilds'), { force: true, recursive: true });
    // node-addon-api is the native package's own build dependency, resolved from its directory; the Server never
    // imports it, so it is deliberately not a Server dependency (the variable keeps knip from demanding one).
    const addonApiManifest = 'node-addon-api/package.json';
    const addonApi = dirname(require.resolve(addonApiManifest, { paths: [source] }));
    await cp(addonApi, join(destination, 'node_modules', 'node-addon-api'), {
        recursive: true,
        dereference: true,
    });
}

const CONTAINER_BUILD_SCRIPT = `set -eu
mkdir -p /opt/node
tar -xzf /input/node.tar.gz -C /opt/node --strip-components=1
export PATH=/opt/node/bin:/opt/python/cp312-cp312/bin:$PATH
gyp=/opt/node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js
for package in node-pty better-sqlite3; do
  cp -R "/input/$package" "/work/$package"
  cd "/work/$package"
  node "$gyp" rebuild --release --nodedir=/opt/node -j max >"/work/$package.log" 2>&1 || { tail -60 "/work/$package.log"; exit 1; }
done
cp /work/node-pty/build/Release/pty.node /output/pty.node
cp /work/better-sqlite3/build/Release/better_sqlite3.node /output/better_sqlite3.node
strip --strip-unneeded /output/pty.node /output/better_sqlite3.node
cd /work/node-pty && node -e "
const pty = require('/work/node-pty');
const terminal = pty.spawn('/bin/sh', ['-c', 'printf caxri-pty-ok'], {});
let output = '';
terminal.onData((data) => { output += data; });
terminal.onExit(() => { if (!output.includes('caxri-pty-ok')) process.exit(1); });
"
node -e "
const Database = require('/work/better-sqlite3/lib/database.js')(() => require('/output/better_sqlite3.node'), false);
const row = new Database(':memory:').prepare('select sqlite_version() as version').get();
if (!row.version) process.exit(1);
"
`;

async function maximumGlibcVersion(
    directory: string,
    names: readonly string[],
    architecture: LinuxArchitecture,
): Promise<string> {
    const { image, platform } = MANYLINUX_IMAGES[architecture];
    const { stdout } = await execFileAsync(
        'docker',
        [
            'run',
            '--rm',
            '--platform',
            platform,
            '-v',
            `${directory}:/check:ro`,
            '-w',
            '/check',
            image,
            'sh',
            '-c',
            `objdump -T "$@" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -Vu | tail -1`,
            'sh',
            ...names,
        ],
        { maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
}

async function assertGlibcBaseline(
    directory: string,
    names: readonly string[],
    architecture: LinuxArchitecture,
): Promise<void> {
    const glibc = await maximumGlibcVersion(directory, names, architecture);
    if (!glibc || compareVersions(glibc, LINUX_GLIBC_BASELINE) > 0)
        throw new Error(
            `Linux ${architecture} ${names.join(', ')} require glibc ${glibc || 'unknown'}, above the ${LINUX_GLIBC_BASELINE} baseline`,
        );
}

function compareVersions(left: string, right: string): number {
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

/**
 * Fetches the prebuilt `@parcel/watcher` Linux package pinned in `pnpm-lock.yaml`, verifying the lockfile's SRI hash.
 * The macOS install never downloads it because pnpm skips optional packages for other platforms.
 */
async function ensureWatcherPackage(architecture: LinuxArchitecture): Promise<string> {
    const watcherVersion = await packageVersion(packageDirectory('@parcel/watcher'));
    const name = `@parcel/watcher-linux-${architecture}-glibc`;
    const lock = await readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8');
    const entry = new RegExp(
        String.raw`^  '${name.replaceAll('/', String.raw`\/`)}@${watcherVersion.replaceAll('.', String.raw`\.`)}':\n    resolution: \{integrity: (sha512-[A-Za-z\d+/=]+)\}`,
        'mu',
    ).exec(lock);
    if (!entry) throw new Error(`pnpm-lock.yaml does not pin ${name}@${watcherVersion}`);
    const integrity = entry[1];
    const destination = join(cacheRoot, 'watcher', `${architecture}-${watcherVersion}`, 'package');
    if (await hasPath(join(destination, 'package.json'))) return destination;
    const tarball = await download(
        `https://registry.npmjs.org/${name}/-/watcher-linux-${architecture}-glibc-${watcherVersion}.tgz`,
    );
    const actual = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    if (actual !== integrity) throw new Error(`Integrity mismatch for ${name}@${watcherVersion}`);
    const parent = dirname(destination);
    await rm(parent, { force: true, recursive: true });
    await mkdir(parent, { recursive: true });
    const tarballPath = join(parent, 'package.tgz');
    await writeFile(tarballPath, tarball);
    await execFileAsync('tar', ['-xzf', tarballPath, '-C', parent]);
    await rm(tarballPath);
    return destination;
}

/**
 * File written next to exported natives so a consumer can prove they were built from the same inputs it would use.
 */
const NATIVES_RECEIPT = 'natives.json';

/**
 * Cache key covering every input that can change the native binaries: the builder script, image, Node runtime, both
 * package versions, and the node-pty patch. Builders on different machines that share a lockfile compute the same key.
 */
async function nativesCacheKey(
    architecture: LinuxArchitecture,
    runtime: LinuxRuntimeSource,
): Promise<string> {
    const inputs = {
        builder: CONTAINER_BUILD_SCRIPT,
        image: MANYLINUX_IMAGES[architecture].image,
        nodePty: await packageVersion(packageDirectory('node-pty')),
        nodePtyPatch: await readFile(resolve(root, 'patches/node-pty@1.1.0.patch'), 'utf8'),
        betterSqlite: await packageVersion(packageDirectory('better-sqlite3')),
        runtime: runtime.sha256,
    };
    return sha256(JSON.stringify(inputs)).slice(0, 16);
}

/**
 * Reads natives a separate Linux job built (see `release.yml`) from `CAXRI_LINUX_NATIVES_DIR/linux-<arch>/`. The
 * override is explicit, so a missing or stale export fails instead of silently falling back to a local Docker build.
 */
async function prebuiltNatives(
    directory: string,
    architecture: LinuxArchitecture,
    key: string,
): Promise<Pick<LinuxNatives, 'betterSqlite' | 'nodePty'>> {
    const output = resolve(directory, `linux-${architecture}`);
    const receiptPath = join(output, NATIVES_RECEIPT);
    if (!(await hasPath(receiptPath)))
        throw new Error(`CAXRI_LINUX_NATIVES_DIR has no ${architecture} natives at ${output}`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { key?: unknown };
    if (receipt.key !== key)
        throw new Error(
            `CAXRI_LINUX_NATIVES_DIR ${architecture} natives were built from different inputs (${String(receipt.key)}, expected ${key})`,
        );
    const natives = {
        betterSqlite: join(output, 'better_sqlite3.node'),
        nodePty: join(output, 'pty.node'),
    };
    if (!(await hasPath(natives.betterSqlite)) || !(await hasPath(natives.nodePty)))
        throw new Error(
            `CAXRI_LINUX_NATIVES_DIR ${architecture} natives are incomplete at ${output}`,
        );
    return natives;
}

/**
 * Builds (or reuses) the Linux native addons for one architecture inside a manylinux 2.28 container. Docker runs on the
 * build host, which may be a Mac (under emulation for the other architecture) or a Linux CI runner; when
 * `CAXRI_LINUX_NATIVES_DIR` is set the addons come from that export instead and Docker is never needed.
 */
export async function ensureLinuxNatives(
    architecture: LinuxArchitecture,
    runtime: LinuxRuntimeSource,
): Promise<LinuxNatives> {
    const [key, watcherPackage] = await Promise.all([
        nativesCacheKey(architecture, runtime),
        ensureWatcherPackage(architecture),
    ]);
    const override = process.env.CAXRI_LINUX_NATIVES_DIR;
    if (override)
        return { ...(await prebuiltNatives(override, architecture, key)), watcherPackage };
    const output = join(cacheRoot, 'natives', `${architecture}-${key}`);
    const natives = {
        betterSqlite: join(output, 'better_sqlite3.node'),
        nodePty: join(output, 'pty.node'),
        watcherPackage,
    };
    if ((await hasPath(natives.betterSqlite)) && (await hasPath(natives.nodePty))) return natives;

    const input = join(cacheRoot, 'natives', `${architecture}-${key}-input`);
    await rm(input, { force: true, recursive: true });
    await rm(output, { force: true, recursive: true });
    await mkdir(output, { recursive: true });
    await stageNativeSource('node-pty', join(input, 'node-pty'));
    await stageNativeSource('better-sqlite3', join(input, 'better-sqlite3'));
    await cp(runtime.tarballPath, join(input, 'node.tar.gz'));
    const { image, platform } = MANYLINUX_IMAGES[architecture];
    try {
        await execFileAsync(
            'docker',
            [
                'run',
                '--rm',
                '--platform',
                platform,
                '-v',
                `${input}:/input:ro`,
                '-v',
                `${output}:/output`,
                '--tmpfs',
                '/work:exec',
                image,
                'sh',
                '-c',
                CONTAINER_BUILD_SCRIPT,
            ],
            { maxBuffer: 16 * 1024 * 1024 },
        );
    } catch (error) {
        await rm(output, { force: true, recursive: true });
        const detail = error instanceof Error && 'stdout' in error ? String(error.stdout) : '';
        throw new Error(
            `Linux ${architecture} native build failed. Docker with ${platform} support is required, or set CAXRI_LINUX_NATIVES_DIR to natives exported by 'linux-target.ts export-natives'.\n${detail}`,
            { cause: error },
        );
    } finally {
        await rm(input, { force: true, recursive: true });
    }
    try {
        await assertGlibcBaseline(output, ['pty.node', 'better_sqlite3.node'], architecture);
    } catch (error) {
        await rm(output, { force: true, recursive: true });
        throw error;
    }
    return natives;
}

/**
 * Builds the natives for one architecture and copies them, with their cache key, to `<directory>/linux-<arch>/`. A
 * Linux CI job runs this natively (Docker on the runner VM, no emulation) and hands the directory to the macOS
 * packaging job as `CAXRI_LINUX_NATIVES_DIR`.
 */
async function exportLinuxNatives(
    architecture: LinuxArchitecture,
    version: string,
    directory: string,
): Promise<string> {
    const runtime = await ensureLinuxRuntime(architecture, version);
    const [key, natives] = await Promise.all([
        nativesCacheKey(architecture, runtime),
        ensureLinuxNatives(architecture, runtime),
    ]);
    const output = resolve(directory, `linux-${architecture}`);
    await rm(output, { force: true, recursive: true });
    await mkdir(output, { recursive: true });
    await cp(natives.nodePty, join(output, 'pty.node'));
    await cp(natives.betterSqlite, join(output, 'better_sqlite3.node'));
    await writeFile(
        join(output, NATIVES_RECEIPT),
        `${JSON.stringify({ architecture, key, runtime: runtime.sha256 }, null, 2)}\n`,
    );
    return output;
}

/**
 * Reads the Node.js version mise pins; the Server runtime and every Linux target follow it.
 */
export async function pinnedRuntimeVersion(): Promise<string> {
    const miseSource = await readFile(resolve(root, 'mise.toml'), 'utf8');
    const version = /^node\s*=\s*"([^"]+)"$/mu.exec(miseSource)?.[1];
    if (!version) throw new Error('mise.toml must pin the Server runtime version');
    return version;
}

/**
 * Parses `--target linux-<arch>` values; returns every architecture when none is given.
 */
export function parseLinuxTargets(argv: readonly string[]): LinuxArchitecture[] {
    const values = argv.flatMap((value, index) => (argv[index - 1] === '--target' ? [value] : []));
    if (values.length === 0) return [...linuxArchitectures];
    return values.map((value) => {
        const architecture = value.startsWith('linux-') ? value.slice('linux-'.length) : '';
        if (!linuxArchitectures.has(architecture as LinuxArchitecture))
            throw new Error(`Unsupported --target ${value}; expected linux-x64 or linux-arm64`);
        return architecture as LinuxArchitecture;
    });
}

if (import.meta.main) {
    const [command, ...rest] = process.argv.slice(2);
    const outputIndex = rest.indexOf('--output');
    const directory = outputIndex === -1 ? undefined : rest[outputIndex + 1];
    if (command !== 'export-natives' || !directory)
        throw new Error(
            'Usage: bun run apps/server/scripts/linux-target.ts export-natives --output <dir> [--target linux-x64|linux-arm64]',
        );
    const version = await pinnedRuntimeVersion();
    for (const architecture of parseLinuxTargets(rest)) {
        // eslint-disable-next-line no-await-in-loop -- one Docker build at a time keeps memory bounded
        const output = await exportLinuxNatives(architecture, version, directory);
        process.stdout.write(`Exported Linux ${architecture} natives to ${output}\n`);
    }
}
