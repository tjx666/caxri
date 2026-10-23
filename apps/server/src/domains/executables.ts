import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';

import { execFileAsync, isAccessible, preferredShell, safeProcessEnvironment } from '@caxri/system';

const LOGIN_PATH_MARKER = '__CAXRI_LOGIN_PATH__';
const LOGIN_ENVIRONMENT_START_MARKER = '__CAXRI_LOGIN_ENV_START__';
const LOGIN_ENVIRONMENT_END_MARKER = '__CAXRI_LOGIN_ENV_END__';
const MAX_LOGIN_PATH_BYTES = 32 * 1024;
const MAX_LOGIN_ENVIRONMENT_BYTES = 512 * 1024;
/**
 * Room for shell startup noise around the environment block; anything larger is not a usable environment.
 */
const MAX_LOGIN_SHELL_OUTPUT_BYTES = 1024 * 1024;
const LOGIN_SHELL_TIMEOUT_MS = 5_000;
/**
 * Bookkeeping the probe shell sets about itself (its cwd, nesting depth, last command). Forwarding it would describe
 * the probe, not the user's configuration, and a stale `PWD` contradicts the Agent's real cwd.
 */
const SHELL_SESSION_KEYS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
/**
 * Caxri owns this namespace for launch, lifecycle, and endpoint wiring; a startup file must not shadow those values.
 */
const CAXRI_ENVIRONMENT_PREFIX = 'CAXRI_';
const ENVIRONMENT_KEY_PATTERN = /^[A-Z_]\w*$/i;
/**
 * Terminal Host rejects a launch plan whose environment exceeds 512 entries, a 256-character name, or a 64 KiB value
 * (`apps/server/src/terminal-host/launch-plan-schema.ts`). Dropping oversized startup-file variables and capping the
 * count below 512 leaves room for the allowlisted launch context and Caxri's per-launch variables, so a heavy shell
 * setup loses a few variables instead of failing every Agent launch.
 */
const MAX_LOGIN_ENVIRONMENT_ENTRIES = 384;
const MAX_ENVIRONMENT_KEY_LENGTH = 256;
const MAX_ENVIRONMENT_VALUE_LENGTH = 64 * 1024;
const MAX_EXECUTABLE_CACHE_ENTRIES = 32;
/**
 * Minimum age of a login-shell snapshot before a missing executable or an Agent launch re-reads it. Installing a CLI
 * can add a PATH directory (a first Homebrew install, a new version-manager shim) and editing a startup file can add an
 * API key; without a re-read either stays invisible until restart. The floor keeps a machine without the CLI from
 * spawning a login shell on every status poll.
 */
const LOGIN_SHELL_REFRESH_MS = 60_000;
/**
 * One `-lic` run reports PATH on a marker line (kept for shells whose `env` lacks `-0`) and the NUL-delimited exported
 * environment between two markers. The syntax is valid in sh, bash, zsh, and fish.
 */
const LOGIN_SHELL_PROBE = [
    String.raw`printf '\n${LOGIN_PATH_MARKER}%s\n' "$PATH"`,
    `printf '${LOGIN_ENVIRONMENT_START_MARKER}'`,
    'command env -0',
    `printf '${LOGIN_ENVIRONMENT_END_MARKER}'`,
].join('; ');

type RunFile = (
    executable: string,
    arguments_: string[],
    options: {
        cwd?: string;
        env: NodeJS.ProcessEnv;
        maxBuffer: number;
        signal?: AbortSignal;
        timeout: number;
    },
) => Promise<{ stderr: string; stdout: string }>;

async function runFile(
    executable: string,
    arguments_: string[],
    options: Parameters<RunFile>[2],
): Promise<{ stderr: string; stdout: string }> {
    return execFileAsync(executable, arguments_, options);
}

async function isExecutable(path: string): Promise<boolean> {
    return isAccessible(path, constants.X_OK);
}

function pathDirectories(path: string | undefined): string[] {
    if (!path || Buffer.byteLength(path, 'utf8') > MAX_LOGIN_PATH_BYTES) return [];
    return path.split(delimiter).filter((directory) => isAbsolute(directory));
}

/**
 * What one interactive login-shell probe reported: the validated PATH and the user's exported variables.
 */
interface LoginShellSnapshot {
    path?: string;
    /**
     * Exported variables minus shell bookkeeping and the `CAXRI_*` namespace. Empty when the shell could not print a
     * NUL-delimited environment (no `env -0`), in which case only PATH is known.
     */
    variables: NodeJS.ProcessEnv;
}

function parseLoginEnvironment(block: string): NodeJS.ProcessEnv {
    const variables: NodeJS.ProcessEnv = {};
    if (Buffer.byteLength(block, 'utf8') > MAX_LOGIN_ENVIRONMENT_BYTES) return variables;
    let count = 0;
    for (const entry of block.split('\0')) {
        if (count >= MAX_LOGIN_ENVIRONMENT_ENTRIES) break;
        const separator = entry.indexOf('=');
        if (separator <= 0) continue;
        const key = entry.slice(0, separator);
        if (
            key.length > MAX_ENVIRONMENT_KEY_LENGTH ||
            entry.length - separator - 1 > MAX_ENVIRONMENT_VALUE_LENGTH ||
            !ENVIRONMENT_KEY_PATTERN.test(key) ||
            SHELL_SESSION_KEYS.has(key) ||
            key.startsWith(CAXRI_ENVIRONMENT_PREFIX)
        )
            continue;
        variables[key] = entry.slice(separator + 1);
        count += 1;
    }
    return variables;
}

/**
 * Parses the probe output: a marker-prefixed PATH line, then `env -0` output between two markers. Startup files may
 * print banners or terminal escapes before either part, so only marker-delimited text is trusted.
 */
function parseLoginShellOutput(stdout: string): LoginShellSnapshot {
    const environmentStart = stdout.indexOf(LOGIN_ENVIRONMENT_START_MARKER);
    const environmentEnd = stdout.lastIndexOf(LOGIN_ENVIRONMENT_END_MARKER);
    const variables =
        environmentStart !== -1 && environmentEnd > environmentStart
            ? parseLoginEnvironment(
                  stdout.slice(
                      environmentStart + LOGIN_ENVIRONMENT_START_MARKER.length,
                      environmentEnd,
                  ),
              )
            : {};
    const line = (environmentStart === -1 ? stdout : stdout.slice(0, environmentStart))
        .split(/\r?\n/)
        .map((candidate) => stripVTControlCharacters(candidate).trim())
        .findLast((candidate) => candidate.startsWith(LOGIN_PATH_MARKER));
    const directories = pathDirectories(line?.slice(LOGIN_PATH_MARKER.length) ?? variables.PATH);
    return {
        ...(directories.length > 0 && { path: directories.join(delimiter) }),
        variables,
    };
}

/**
 * Resolves a fixed executable allowlist against the GUI environment plus a bounded interactive login-shell probe. The
 * probe reports PATH and the user's exported variables; Server commands take only its PATH, while Agent processes take
 * the whole environment so they see what the same Agent would see in the user's own terminal.
 */
export class ExecutableResolver {
    private readonly executableCache = new Map<string, string>();
    private loginSnapshotRequest: Promise<LoginShellSnapshot | undefined> | undefined;
    private loginSnapshotRequestedAt = 0;

    constructor(
        private readonly sourceEnvironment: () => NodeJS.ProcessEnv = () => process.env,
        private readonly run: RunFile = runFile,
        private readonly now: () => number = Date.now,
    ) {}

    private cache(name: string, path: string): string {
        this.executableCache.delete(name);
        this.executableCache.set(name, path);
        if (this.executableCache.size > MAX_EXECUTABLE_CACHE_ENTRIES) {
            const oldestName = this.executableCache.keys().next().value;
            if (oldestName) this.executableCache.delete(oldestName);
        }
        return path;
    }

    private async findInPath(name: string, path: string | undefined): Promise<string | undefined> {
        for (const directory of pathDirectories(path)) {
            const candidate = join(directory, name);
            // Directories are searched in PATH order and the first executable match wins, so this
            // loop cannot be parallelized with Promise.all without changing which match is picked.
            // eslint-disable-next-line no-await-in-loop -- ordered first-match search, see comment above
            if (await isExecutable(candidate)) return candidate;
        }
        return undefined;
    }

    /**
     * Shares one in-flight probe between callers. A caller that needs fresh startup-file changes passes `maxAgeMs`; a
     * refresh that fails keeps the previous snapshot so one slow shell start cannot strip PATH from a working setup.
     */
    private loginSnapshot(maxAgeMs?: number): Promise<LoginShellSnapshot | undefined> {
        const isStale =
            maxAgeMs !== undefined && this.now() - this.loginSnapshotRequestedAt >= maxAgeMs;
        return isStale || !this.loginSnapshotRequest
            ? this.refreshLoginSnapshot()
            : this.loginSnapshotRequest;
    }

    private refreshLoginSnapshot(): Promise<LoginShellSnapshot | undefined> {
        const previous = this.loginSnapshotRequest;
        this.loginSnapshotRequestedAt = this.now();
        const request = (async () => (await this.readLoginSnapshot()) ?? (await previous))();
        this.loginSnapshotRequest = request;
        return request;
    }

    private async loginPath(maxAgeMs?: number): Promise<string | undefined> {
        return (await this.loginSnapshot(maxAgeMs))?.path;
    }

    private async readLoginSnapshot(): Promise<LoginShellSnapshot | undefined> {
        const source = this.sourceEnvironment();
        const shell = preferredShell(source);
        try {
            const { stdout } = await this.run(shell, ['-lic', LOGIN_SHELL_PROBE], {
                env: safeProcessEnvironment(source),
                timeout: LOGIN_SHELL_TIMEOUT_MS,
                maxBuffer: MAX_LOGIN_SHELL_OUTPUT_BYTES,
            });
            const snapshot = parseLoginShellOutput(stdout);
            return snapshot.path ? snapshot : undefined;
        } catch {
            return undefined;
        }
    }

    clear(): void {
        this.executableCache.clear();
        this.loginSnapshotRequest = undefined;
        this.loginSnapshotRequestedAt = 0;
    }

    async resolve(requestedExecutable: string): Promise<string | undefined> {
        const requested = requestedExecutable.trim();
        if (!requested || requested.length > 4_096 || requested.includes('\0')) return undefined;
        if (isAbsolute(requested)) return (await isExecutable(requested)) ? requested : undefined;
        if (requested.includes('/')) return undefined;

        const cached = this.executableCache.get(requested);
        if (cached && (await isExecutable(cached))) return cached;
        /**
         * Re-read PATH after a cached install moved or was replaced while Caxri was running.
         */
        if (cached) this.executableCache.delete(requested);

        const source = this.sourceEnvironment();
        const direct = await this.findInPath(requested, source.PATH);
        if (direct) return this.cache(requested, direct);
        const login = await this.loginPath(cached ? 0 : undefined);
        const discovered = await this.findInPath(requested, login);
        if (discovered) return this.cache(requested, discovered);
        if (this.now() - this.loginSnapshotRequestedAt < LOGIN_SHELL_REFRESH_MS) return undefined;
        const refreshed = await this.findInPath(requested, await this.loginPath(0));
        return refreshed ? this.cache(requested, refreshed) : undefined;
    }

    /**
     * The secret-minimized environment for Server-owned commands (Git, `gh`, version probes). Only the login-shell PATH
     * is imported, because the Server's own PATH is whatever launchd gave the GUI; other startup-file variables such as
     * `LANG` or `GIT_*` could change output Caxri parses.
     *
     * @param variables Environment to sanitize and PATH-correct.
     */
    async environment(
        variables: NodeJS.ProcessEnv = this.sourceEnvironment(),
    ): Promise<NodeJS.ProcessEnv> {
        const loginPath = await this.loginPath();
        return {
            ...safeProcessEnvironment(variables),
            ...(loginPath && { PATH: loginPath }),
        };
    }

    /**
     * The environment an Agent process starts from, matching what the same Agent would inherit in the user's own
     * terminal: every variable the interactive login shell exports (API keys an MCP server reads, proxies, toolchain
     * homes). The allowlisted launch context Caxri itself received still wins, so an isolated `HOME` or `CODEX_HOME`
     * from a test or portable launch is never replaced by a startup-file value; the login-shell PATH wins as
     * everywhere. The snapshot is re-read when older than {@link LOGIN_SHELL_REFRESH_MS}, so editing a startup file
     * reaches the next Agent launch without restarting Server Core. VS Code resolves a GUI launch's environment the
     * same way: an interactive login shell prints its whole environment between markers
     * (`src/vs/platform/shell/node/shellEnv.ts`).
     *
     * @param variables Launch context to sanitize and layer over the login-shell variables.
     */
    async agentEnvironment(
        variables: NodeJS.ProcessEnv = this.sourceEnvironment(),
    ): Promise<NodeJS.ProcessEnv> {
        const snapshot = await this.loginSnapshot(LOGIN_SHELL_REFRESH_MS);
        return {
            ...snapshot?.variables,
            ...safeProcessEnvironment(variables),
            ...(snapshot?.path && { PATH: snapshot.path }),
        };
    }
}

const serverExecutableResolver = new ExecutableResolver();

export function clearServerExecutableCache(): void {
    serverExecutableResolver.clear();
}

export function resolveServerExecutable(name: string): Promise<string | undefined> {
    return serverExecutableResolver.resolve(name);
}

export function serverProcessEnvironment(
    variables?: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
    return serverExecutableResolver.environment(variables);
}

export function agentProcessEnvironment(variables?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    return serverExecutableResolver.agentEnvironment(variables);
}

/**
 * Fires the login-shell probe without waiting for it (issue caxri#1345). `ExecutableResolver.loginSnapshot()` memoizes
 * the in-flight request on the shared resolver, so the first real external command (often Git, from the Project Status
 * refresh moments after startup) reuses this request instead of paying its own login-shell spawn (~0.1s typically, up
 * to `LOGIN_SHELL_TIMEOUT_MS` on a slow shell profile) synchronously on the user's first action. `readLoginSnapshot`
 * already catches its own failures and resolves `undefined`, so this can never produce an unhandled rejection.
 */
export function warmServerExecutablePath(): void {
    void serverProcessEnvironment();
}

export interface ExternalCommandOptions {
    cwd?: string;
    /**
     * Extra variables merged over the resolved login-shell environment.
     */
    env?: NodeJS.ProcessEnv;
    maxBuffer: number;
    signal?: AbortSignal;
    timeout: number;
}

export interface ExternalCommandDependencies {
    environment?: () => Promise<NodeJS.ProcessEnv>;
    resolveExecutable?: (name: string) => Promise<string | undefined>;
    run?: RunFile;
}

/**
 * Runs an external CLI (`gh`, `linear`, `vc`, Agent binaries, …) through the login-shell PATH boundary. A GUI-launched
 * packaged app inherits the constrained macOS launchd PATH without Homebrew-style directories, so Server code must
 * never spawn a bare command name directly: this wrapper owns resolution, the sanitized environment, and the ENOENT
 * contract (`<name> was not found`) that callers map into their own error domains.
 */
export async function runExternalCommand(
    name: string,
    arguments_: readonly string[],
    options: ExternalCommandOptions,
    dependencies: ExternalCommandDependencies = {},
): Promise<{ stderr: string; stdout: string }> {
    const resolveExecutable = dependencies.resolveExecutable ?? resolveServerExecutable;
    const readEnvironment = dependencies.environment ?? serverProcessEnvironment;
    const run = dependencies.run ?? runFile;
    const executable = await resolveExecutable(name);
    if (!executable) {
        const missing = new Error(`${name} was not found`) as NodeJS.ErrnoException;
        missing.code = 'ENOENT';
        throw missing;
    }
    return run(executable, [...arguments_], {
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        env: { ...(await readEnvironment()), ...options.env },
        maxBuffer: options.maxBuffer,
        ...(options.signal && { signal: options.signal }),
        timeout: options.timeout,
    });
}
