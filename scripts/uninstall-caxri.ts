import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOST_SHUTDOWN_TIMEOUT_MS = 10_000;
const HOST_ENTRY_PATTERN = /(?:^|\/)out\/main\/host\.js(?:\s|$)/u;
const WORKTREE_PROFILE_ID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface CaxriUninstallOptions {
    apply: boolean;
    archiveRootPath: string;
    devProfileRoot?: string;
    homeDirectory: string;
    includeDevProfiles: boolean;
    profilePath: string;
    removeApplications: boolean;
    removeGlobalCli: boolean;
}

interface FailedUninstallTarget {
    message: string;
    path: string;
}

export interface CaxriUninstallResult {
    applied: boolean;
    archiveDirectory?: string;
    cliRemoval: 'failed' | 'removed' | 'skipped';
    failedTargets: FailedUninstallTarget[];
    hostPids: number[];
    movedTargets: string[];
    targets: string[];
}

type ArchiveStatus = 'archived' | 'failed' | 'missing' | 'planned';

interface ArchivedTarget {
    archivedPath: string;
    error?: string;
    originalPath: string;
    status: ArchiveStatus;
}

interface UninstallArchiveManifest {
    archiveDirectory: string;
    createdAt: string;
    schemaVersion: 1;
    targets: ArchivedTarget[];
}

interface OwnedHost {
    endpointPath: string;
    lockPath: string;
    pid: number;
    profilePath: string;
}

interface UninstallPlan {
    hosts: OwnedHost[];
    targets: string[];
}

interface UninstallOperations {
    inspectPathOwner(path: string): Promise<number | undefined>;
    inspectProcess(pid: number): Promise<string | undefined>;
    moveToArchive(source: string, destination: string): Promise<void>;
    removeGlobalCli(): Promise<void>;
    signalProcess(pid: number, signal: NodeJS.Signals): void;
    waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
}

function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function usage(): string {
    return `Usage: bun run uninstall:caxri -- [options]

Options:
  --yes             Stop verified Caxri Hosts and archive local Caxri data
  --profile PATH    Include an additional absolute profile whose name contains "caxri"
  --keep-app        Keep /Applications/Caxri.app and ~/Applications/Caxri.app
  --keep-cli        Keep the globally linked @caxri/cli package
  --keep-dev        Keep managed switch-worktree development profiles
  --help            Show this help

Archives and an original-path manifest are kept in caxri-uninstall-archives beside the primary
Caxri checkout. Without --yes the command is a verified dry run. Project directories and user
files are never targets.`;
}

function assertProfileName(profilePath: string): void {
    if (!basename(profilePath).toLowerCase().includes('caxri'))
        throw new Error(
            'The uninstall profile directory name must contain "caxri" to prevent broad deletion',
        );
}

export function parseUninstallArguments(
    argv: readonly string[],
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory = homedir(),
    repoRoot = process.cwd(),
): CaxriUninstallOptions | { help: true } {
    let isApply = false;
    let profilePath =
        environment.CAXRI_USER_DATA_DIR ??
        join(homeDirectory, 'Library', 'Application Support', 'Caxri');
    let isRemoveApps = true;
    let isRemoveGlobalCli = true;
    let isIncludeDevelopmentProfiles = true;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (argument === '--help') return { help: true };
        if (argument === '--yes') {
            isApply = true;
            continue;
        }
        if (argument === '--keep-app') {
            isRemoveApps = false;
            continue;
        }
        if (argument === '--keep-cli') {
            isRemoveGlobalCli = false;
            continue;
        }
        if (argument === '--keep-dev') {
            isIncludeDevelopmentProfiles = false;
            continue;
        }
        if (argument === '--profile') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) throw new Error('--profile requires a path');
            profilePath = value;
            index += 1;
            continue;
        }
        throw new Error(`Unknown uninstall option: ${argument}`);
    }
    if (!isAbsolute(profilePath)) throw new Error('The uninstall profile path must be absolute');
    assertProfileName(profilePath);
    return {
        apply: isApply,
        archiveRootPath: uninstallArchiveRoot(repoRoot),
        homeDirectory: resolve(homeDirectory),
        includeDevProfiles: isIncludeDevelopmentProfiles,
        profilePath: resolve(profilePath),
        removeApplications: isRemoveApps,
        removeGlobalCli: isRemoveGlobalCli,
    };
}

function isWithin(parent: string, child: string): boolean {
    const relationship = relative(parent, child);
    return relationship !== '' && relationship !== '..' && !relationship.startsWith(`..${sep}`);
}

function standardProfilePaths(options: CaxriUninstallOptions): [string, string] {
    const appSupport = join(options.homeDirectory, 'Library', 'Application Support');
    return [join(appSupport, 'Caxri'), join(appSupport, 'caxri')];
}

function assertSafeTarget(path: string, options: CaxriUninstallOptions): void {
    const target = resolve(path);
    const forbidden = new Set([
        '/',
        options.homeDirectory,
        join(options.homeDirectory, 'Library'),
        join(options.homeDirectory, 'Library', 'Application Support'),
        '/Applications',
    ]);
    if (forbidden.has(target)) throw new Error(`Refusing broad uninstall target: ${target}`);
    const isExactProfile = target === options.profilePath;
    const isStandardHomeTarget = isWithin(options.homeDirectory, target);
    if (!isExactProfile && !isStandardHomeTarget && target !== '/Applications/Caxri.app')
        throw new Error(`Refusing non-Caxri uninstall target: ${target}`);
}

export function resolveUninstallTargets(
    options: CaxriUninstallOptions,
    additionalProfiles: readonly string[] = [],
): string[] {
    const library = join(options.homeDirectory, 'Library');
    const paths = [
        options.profilePath,
        ...standardProfilePaths(options),
        ...additionalProfiles,
        join(library, 'Caches', 'Caxri'),
        join(library, 'Caches', 'com.caxri.app'),
        join(library, 'HTTPStorages', 'com.caxri.app'),
        join(library, 'HTTPStorages', 'com.caxri.app.binarycookies'),
        join(library, 'Logs', 'Caxri'),
        join(library, 'Preferences', 'com.caxri.app.plist'),
        join(library, 'Saved Application State', 'com.caxri.app.savedState'),
        join(library, 'WebKit', 'com.caxri.app'),
        ...(options.removeApplications
            ? [join(options.homeDirectory, 'Applications', 'Caxri.app'), '/Applications/Caxri.app']
            : []),
    ];
    const targets = [...new Set(paths.map((path) => resolve(path)))].filter(
        (candidate, index, candidates) =>
            candidates.every(
                (parent, parentIndex) => parentIndex === index || !isWithin(parent, candidate),
            ),
    );
    for (const target of targets) assertSafeTarget(target, options);
    return targets;
}

async function optionalMetadata(path: string) {
    try {
        return await lstat(path);
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT') return;
        throw error;
    }
}

async function assertNotInsideGitWorktree(path: string): Promise<void> {
    // Each ancestor check depends on the previous directory in the walk, so this must stay
    // sequential rather than run concurrently.
    for (let current = path; ; current = dirname(current)) {
        // eslint-disable-next-line no-await-in-loop -- sequential ancestor-directory walk
        if (await optionalMetadata(join(current, '.git')))
            throw new Error(`Refusing Caxri profile inside a Git worktree: ${path}`);
        const parent = dirname(current);
        if (parent === current) return;
    }
}

async function hasProfileMarker(path: string): Promise<boolean> {
    const database = await optionalMetadata(join(path, 'caxri.db'));
    if (database?.isSymbolicLink())
        throw new Error(`Refusing symlink Caxri profile marker: ${join(path, 'caxri.db')}`);
    if (database?.isFile()) return true;
    const host = await optionalMetadata(join(path, 'host'));
    if (host?.isSymbolicLink())
        throw new Error(`Refusing symlink Caxri profile marker: ${join(path, 'host')}`);
    return host?.isDirectory() === true;
}

async function assertSelectedProfile(options: CaxriUninstallOptions): Promise<void> {
    const metadata = await optionalMetadata(options.profilePath);
    if (!metadata) return;
    if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    )
        throw new Error(`Refusing unsafe Caxri profile: ${options.profilePath}`);
    const standards = new Set(standardProfilePaths(options));
    if (standards.has(options.profilePath)) return;
    await assertNotInsideGitWorktree(options.profilePath);
    if (!(await hasProfileMarker(options.profilePath)))
        throw new Error(`Refusing directory without Caxri profile markers: ${options.profilePath}`);
}

async function discoverManagedDevelopmentProfiles(
    options: CaxriUninstallOptions,
): Promise<string[]> {
    if (!options.includeDevProfiles || !options.devProfileRoot) return [];
    const root = resolve(options.devProfileRoot);
    if (basename(root) !== 'profiles' || basename(dirname(root)) !== 'caxri-worktree-state') {
        throw new Error(`Refusing unexpected managed development profile root: ${root}`);
    }
    const metadata = await optionalMetadata(root);
    if (!metadata) return [];
    if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    ) {
        throw new Error(`Refusing unsafe managed development profile root: ${root}`);
    }
    const profiles: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        if (!WORKTREE_PROFILE_ID.test(entry.name)) continue;
        const path = join(root, entry.name);
        // Each candidate must be individually validated as safe before being trusted, and the
        // validation order has no observable effect, but kept sequential to avoid opening many
        // concurrent filesystem handles while walking an untrusted directory.
        // eslint-disable-next-line no-await-in-loop -- sequential per-entry safety validation
        const entryMetadata = await lstat(path);
        if (
            !entryMetadata.isDirectory() ||
            entryMetadata.isSymbolicLink() ||
            (typeof process.getuid === 'function' && entryMetadata.uid !== process.getuid())
        ) {
            throw new Error(`Refusing unsafe managed development profile: ${path}`);
        }
        profiles.push(path);
    }
    return profiles.toSorted((left, right) => left.localeCompare(right));
}

function metadataIdentity(path: string, metadata: Awaited<ReturnType<typeof lstat>>): string {
    return metadata.isSymbolicLink()
        ? `link:${resolve(path)}`
        : `${String(metadata.dev)}:${String(metadata.ino)}`;
}

async function existingRealTargets(paths: readonly string[]): Promise<string[]> {
    const identities = new Set<string>();
    const targets: string[] = [];
    for (const path of paths) {
        // Deduplication keeps the first occurrence of each filesystem identity, so paths must be
        // checked in their given order rather than concurrently.
        // eslint-disable-next-line no-await-in-loop -- sequential first-occurrence deduplication
        const metadata = await optionalMetadata(path);
        if (!metadata) continue;
        const identity = metadataIdentity(path, metadata);
        if (identities.has(identity)) continue;
        identities.add(identity);
        targets.push(path);
    }
    return targets;
}

function socketDirectory(): string {
    return process.platform === 'darwin' ? '/private/tmp' : tmpdir();
}

async function resolveProfileEndpoint(profilePath: string): Promise<string> {
    let canonicalProfile: string;
    try {
        canonicalProfile = await realpath(profilePath);
    } catch (error) {
        if (fileSystemCode(error) !== 'ENOENT') throw error;
        /**
         * A detached Host can outlive profile cleanup. Canonicalizing the still-existing parent preserves the exact
         * endpoint hash without trusting stale manifest PID metadata.
         */
        canonicalProfile = join(await realpath(dirname(profilePath)), basename(profilePath));
    }
    const profileId = createHash('sha256').update(canonicalProfile).digest('hex').slice(0, 24);
    return join(socketDirectory(), `caxri-host-${profileId}.sock`);
}

async function discoverProfilePaths(
    options: CaxriUninstallOptions,
    managedDevelopmentProfiles: readonly string[],
): Promise<string[]> {
    const profiles = new Map<string, string>();
    const trustedManagedProfiles = new Set(managedDevelopmentProfiles);
    const candidates = new Set([
        options.profilePath,
        ...standardProfilePaths(options),
        ...managedDevelopmentProfiles,
    ]);
    // Deduplication by canonical path keeps the first matching candidate, so candidates must be
    // validated in order rather than concurrently.
    for (const candidate of candidates) {
        // eslint-disable-next-line no-await-in-loop -- sequential first-occurrence deduplication
        const metadata = await optionalMetadata(candidate);
        if (!metadata) {
            if (candidate === options.profilePath) profiles.set(candidate, candidate);
            continue;
        }
        if (
            !metadata.isDirectory() ||
            metadata.isSymbolicLink() ||
            (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
            // eslint-disable-next-line no-await-in-loop -- sequential first-occurrence deduplication
            (!trustedManagedProfiles.has(candidate) && !(await hasProfileMarker(candidate)))
        )
            continue;
        // eslint-disable-next-line no-await-in-loop -- sequential first-occurrence deduplication
        const canonical = await realpath(candidate);
        if (!profiles.has(canonical)) profiles.set(canonical, candidate);
    }
    return profiles.values().toArray();
}

async function existingProfileEndpoint(profilePath: string): Promise<string | undefined> {
    const endpoint = await resolveProfileEndpoint(profilePath);
    const metadata = await optionalMetadata(endpoint);
    if (!metadata) return undefined;
    if (
        !metadata.isSocket() ||
        metadata.isSymbolicLink() ||
        (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    )
        throw new Error(`Refusing unsafe Host endpoint: ${endpoint}`);
    return endpoint;
}

async function inspectPathOwner(path: string): Promise<number | undefined> {
    try {
        const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-F', 'p', '--', path]);
        const pids = new Set(
            stdout
                .split(/\r?\n/u)
                .filter((line) => /^p\d+$/u.test(line))
                .map((line) => Number(line.slice(1))),
        );
        if (pids.size > 1) throw new Error(`Multiple processes own Caxri path: ${path}`);
        return [...pids][0];
    } catch (error) {
        if (fileSystemCode(error) === '1') return undefined;
        throw error;
    }
}

async function inspectProcess(pid: number): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'command=']);
        return stdout.trim() || undefined;
    } catch (error) {
        if (fileSystemCode(error) === '1') return undefined;
        throw error;
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return fileSystemCode(error) !== 'ESRCH';
    }
}

async function didProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) return true;
        // Polling loop: each check depends on elapsed wall-clock time since the previous one, so
        // it cannot be parallelized.
        // eslint-disable-next-line no-await-in-loop -- sequential liveness-polling delay
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !isProcessAlive(pid);
}

export async function removeGlobalCaxriCli(
    runCommand: (command: string, arguments_: string[]) => Promise<{ stdout: string }> = async (
        command,
        arguments_,
    ) => {
        const { stdout } = await execFileAsync(command, arguments_);
        return { stdout };
    },
): Promise<void> {
    const listArguments = ['list', '--global', '--depth', '0', '--json', '@caxri/cli'];
    const { stdout } = await runCommand('pnpm', listArguments);
    const listing: unknown = JSON.parse(stdout);
    if (!Array.isArray(listing)) throw new Error('pnpm global package listing is not an array');
    const isInstalled = listing.some((entry) => {
        if (typeof entry !== 'object' || entry === null) return false;
        const dependencies = (entry as Record<string, unknown>).dependencies;
        return (
            typeof dependencies === 'object' &&
            dependencies !== null &&
            Object.hasOwn(dependencies, '@caxri/cli')
        );
    });
    if (isInstalled) await runCommand('pnpm', ['remove', '--global', '@caxri/cli']);
}

const defaultOperations: UninstallOperations = {
    inspectPathOwner,
    inspectProcess,
    moveToArchive: (source, destination) => rename(source, destination),
    removeGlobalCli: removeGlobalCaxriCli,
    signalProcess: (pid, signal) => process.kill(pid, signal),
    waitForExit: didProcessExit,
};

function operationsWith(overrides: Partial<UninstallOperations> | undefined): UninstallOperations {
    return { ...defaultOperations, ...overrides };
}

async function resolveOwnedHost(
    profilePath: string,
    endpointPath: string,
    operations: UninstallOperations,
): Promise<OwnedHost | undefined> {
    const lockPath = join(profilePath, 'host', 'owner.lock');
    const lock = await optionalMetadata(lockPath);
    if (
        lock &&
        (!lock.isFile() ||
            lock.isSymbolicLink() ||
            (typeof process.getuid === 'function' && lock.uid !== process.getuid()))
    )
        throw new Error(`Refusing unsafe Host lock: ${lockPath}`);
    const owners = new Set<number>();
    if (lock) {
        const lockOwner = await operations.inspectPathOwner(lockPath);
        if (lockOwner) owners.add(lockOwner);
    }
    const endpointOwner = await operations.inspectPathOwner(endpointPath);
    if (endpointOwner) owners.add(endpointOwner);
    if (owners.size > 1)
        throw new Error(`Host lock and endpoint are owned by different processes: ${profilePath}`);
    const pid = [...owners][0];
    if (!pid) return undefined;
    const command = await operations.inspectProcess(pid);
    if (!command) {
        const remainingOwners = await Promise.all(
            [lock ? lockPath : undefined, endpointPath]
                .filter((path): path is string => path !== undefined)
                .map((path) => operations.inspectPathOwner(path)),
        );
        if (remainingOwners.every((owner) => owner === undefined)) return undefined;
        throw new Error(`Cannot inspect process ${pid} that owns Caxri profile ${profilePath}`);
    }
    if (!HOST_ENTRY_PATTERN.test(command))
        throw new Error(`Refusing to signal PID ${pid}: it is not a verified Caxri Host`);
    return { endpointPath, lockPath, pid, profilePath };
}

async function createUninstallPlan(
    options: CaxriUninstallOptions,
    operations: UninstallOperations,
): Promise<UninstallPlan> {
    await assertSelectedProfile(options);
    const managedDevelopmentProfiles = await discoverManagedDevelopmentProfiles(options);
    const profiles = await discoverProfilePaths(options, managedDevelopmentProfiles);
    const endpoints = (
        await Promise.all(profiles.map((profile) => existingProfileEndpoint(profile)))
    ).filter((path): path is string => path !== undefined);
    const hosts = (
        await Promise.all(
            profiles.map(async (profile) => {
                const endpoint = await resolveProfileEndpoint(profile);
                return resolveOwnedHost(profile, endpoint, operations);
            }),
        )
    ).filter((host): host is OwnedHost => host !== undefined);
    const targets = await existingRealTargets([
        ...resolveUninstallTargets(options, managedDevelopmentProfiles),
        ...endpoints,
    ]);
    return { hosts, targets };
}

async function stopOwnedHosts(
    hosts: readonly OwnedHost[],
    operations: UninstallOperations,
): Promise<number[]> {
    const stopped: number[] = [];
    // Hosts are stopped one at a time so a mid-loop failure leaves a precisely known set of
    // already-stopped PIDs for the caller and tests to reason about.
    for (const expected of hosts) {
        // eslint-disable-next-line no-await-in-loop -- sequential Host shutdown with a known-stopped prefix on failure
        const current = await resolveOwnedHost(
            expected.profilePath,
            expected.endpointPath,
            operations,
        );
        if (!current) continue;
        if (current.pid !== expected.pid)
            throw new Error(`Caxri Host ownership changed for profile ${expected.profilePath}`);
        operations.signalProcess(current.pid, 'SIGTERM');
        // eslint-disable-next-line no-await-in-loop -- sequential Host shutdown with a known-stopped prefix on failure
        if (!(await operations.waitForExit(current.pid, HOST_SHUTDOWN_TIMEOUT_MS)))
            throw new Error(`Caxri Host PID ${current.pid} did not stop; local data was not moved`);
        stopped.push(current.pid);
    }
    return stopped;
}

export function uninstallArchiveRoot(repoRoot: string): string {
    const root = resolve(repoRoot);
    return join(dirname(root), `${basename(root)}-uninstall-archives`);
}

async function createArchiveDirectory(archiveRootPath: string): Promise<string> {
    const root = resolve(archiveRootPath);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(root);
    if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    ) {
        throw new Error(`Refusing unsafe Caxri uninstall archive root: ${root}`);
    }
    const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
    return mkdtemp(join(root, `uninstall-${timestamp}-`));
}

async function writeArchiveManifest(manifest: UninstallArchiveManifest): Promise<void> {
    const temporaryPath = join(
        manifest.archiveDirectory,
        `.manifest-${process.pid}-${randomUUID()}.tmp`,
    );
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    await rename(temporaryPath, join(manifest.archiveDirectory, 'manifest.json'));
}

export async function uninstallCaxri(
    options: CaxriUninstallOptions,
    operationOverrides?: Partial<UninstallOperations>,
): Promise<CaxriUninstallResult> {
    const operations = operationsWith(operationOverrides);
    const plan = await createUninstallPlan(options, operations);
    const hostPids = plan.hosts.map((host) => host.pid);
    if (!options.apply)
        return {
            applied: false,
            cliRemoval: 'skipped',
            failedTargets: [],
            hostPids,
            movedTargets: [],
            targets: plan.targets,
        };

    await stopOwnedHosts(plan.hosts, operations);

    const archiveDirectory =
        plan.targets.length > 0 ? await createArchiveDirectory(options.archiveRootPath) : undefined;

    const failedTargets: FailedUninstallTarget[] = [];
    const movedTargets: string[] = [];
    if (archiveDirectory) {
        const manifest: UninstallArchiveManifest = {
            archiveDirectory,
            createdAt: new Date().toISOString(),
            schemaVersion: 1,
            targets: plan.targets.map((source, index) => ({
                archivedPath: join(
                    archiveDirectory,
                    `${String(index + 1).padStart(2, '0')}-${basename(source)}`,
                ),
                originalPath: source,
                status: 'planned',
            })),
        };
        await writeArchiveManifest(manifest);
        // The manifest is rewritten after every target so a crash mid-archive leaves an
        // accurate on-disk record of exactly which targets were already moved; that recovery
        // guarantee requires each target to be archived and persisted before the next begins.
        for (const target of manifest.targets) {
            try {
                // eslint-disable-next-line no-await-in-loop -- incremental crash-recoverable manifest persistence
                await operations.moveToArchive(target.originalPath, target.archivedPath);
                target.status = 'archived';
                movedTargets.push(target.originalPath);
            } catch (error) {
                if (fileSystemCode(error) === 'ENOENT') target.status = 'missing';
                else {
                    target.error = errorMessage(error);
                    target.status = 'failed';
                    failedTargets.push({ message: target.error, path: target.originalPath });
                }
            }
            // eslint-disable-next-line no-await-in-loop -- incremental crash-recoverable manifest persistence
            await writeArchiveManifest(manifest);
        }
    }

    let cliRemoval: CaxriUninstallResult['cliRemoval'] = 'skipped';
    if (options.removeGlobalCli) {
        try {
            await operations.removeGlobalCli();
            cliRemoval = 'removed';
        } catch {
            cliRemoval = 'failed';
        }
    }
    return {
        applied: true,
        cliRemoval,
        failedTargets,
        hostPids,
        movedTargets,
        targets: plan.targets,
        ...(archiveDirectory && { archiveDirectory }),
    };
}

export async function resolveUninstallRepoPaths(workingDirectory: string): Promise<{
    devProfileRoot: string;
    repositoryRoot: string;
}> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
        cwd: workingDirectory,
    });
    const source = stdout.trim();
    if (!source) throw new Error('Git did not report a common directory for Caxri');
    const unresolvedCommonDirectory = isAbsolute(source)
        ? source
        : resolve(workingDirectory, source);
    const commonDirectory = await realpath(unresolvedCommonDirectory);
    if (basename(commonDirectory) !== '.git') {
        throw new Error(`Refusing unexpected Caxri Git common directory: ${commonDirectory}`);
    }
    return {
        devProfileRoot: join(commonDirectory, 'caxri-worktree-state', 'profiles'),
        repositoryRoot: dirname(commonDirectory),
    };
}

async function main(): Promise<void> {
    const repoPaths = await resolveUninstallRepoPaths(process.cwd());
    const parsed = parseUninstallArguments(
        process.argv.slice(2),
        process.env,
        homedir(),
        repoPaths.repositoryRoot,
    );
    if ('help' in parsed) {
        console.log(usage());
        return;
    }
    const options: CaxriUninstallOptions = parsed.includeDevProfiles
        ? {
              ...parsed,
              devProfileRoot: repoPaths.devProfileRoot,
          }
        : parsed;
    const result = await uninstallCaxri(options);
    if (!result.applied) {
        console.log('Caxri uninstall verified dry run. Nothing was changed.');
        for (const pid of result.hostPids) console.log(`Would stop verified Host PID ${pid}.`);
        for (const target of result.targets) console.log(`Would archive: ${target}`);
        if (options.removeGlobalCli) console.log('Would ensure global @caxri/cli is unlinked.');
        console.log(`Archive root: ${options.archiveRootPath}`);
        console.log('Re-run with --yes to apply this plan.');
        return;
    }
    if (result.archiveDirectory)
        console.log(
            `Archived ${result.movedTargets.length} Caxri item(s) at ${result.archiveDirectory}.`,
        );
    else console.log('No Caxri filesystem data was present.');
    for (const failure of result.failedTargets)
        console.warn(`Could not move ${failure.path}: ${failure.message}`);
    if (result.cliRemoval === 'failed')
        console.warn('Could not unlink global @caxri/cli; run bun run unlink:cli separately.');
    if (result.failedTargets.length > 0 || result.cliRemoval === 'failed') process.exitCode = 1;
}

if (import.meta.main) {
    try {
        await main();
    } catch (error: unknown) {
        console.error(errorMessage(error));
        process.exitCode = 1;
    }
}
