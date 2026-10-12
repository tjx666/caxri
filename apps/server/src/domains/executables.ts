import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';

import { execFileAsync, isAccessible, preferredShell, safeProcessEnvironment } from '@caxri/system';

const LOGIN_PATH_MARKER = '__CAXRI_LOGIN_PATH__';
const MAX_LOGIN_PATH_BYTES = 32 * 1024;
const LOGIN_SHELL_TIMEOUT_MS = 5_000;
const MAX_EXECUTABLE_CACHE_ENTRIES = 32;
/**
 * Minimum age of a login-shell PATH before a missing executable re-reads it. Installing a CLI can add a PATH directory
 * (a first Homebrew install, a new version-manager shim); without a re-read that install stays invisible until restart.
 * The floor keeps a machine without the CLI from spawning a login shell on every status poll.
 */
const LOGIN_PATH_REFRESH_MS = 60_000;

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
 * Resolves a fixed executable allowlist against the GUI environment plus a bounded login-shell PATH. The shell prints
 * only PATH behind a marker; Caxri never imports the rest of its environment.
 */
export class ExecutableResolver {
    private readonly executableCache = new Map<string, string>();
    private loginPathRequest: Promise<string | undefined> | undefined;
    private loginPathRequestedAt = 0;

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

    private loginPath(): Promise<string | undefined> {
        if (!this.loginPathRequest) {
            this.loginPathRequestedAt = this.now();
            this.loginPathRequest = this.readLoginPath();
        }
        return this.loginPathRequest;
    }

    private async readLoginPath(): Promise<string | undefined> {
        const source = this.sourceEnvironment();
        const shell = preferredShell(source);
        try {
            const { stdout } = await this.run(
                shell,
                ['-lic', String.raw`printf '\n${LOGIN_PATH_MARKER}%s\n' "$PATH"`],
                {
                    env: safeProcessEnvironment(source),
                    timeout: LOGIN_SHELL_TIMEOUT_MS,
                    maxBuffer: MAX_LOGIN_PATH_BYTES,
                },
            );
            const line = stdout
                .split(/\r?\n/)
                .map((candidate) => stripVTControlCharacters(candidate).trim())
                .findLast((candidate) => candidate.startsWith(LOGIN_PATH_MARKER));
            const path = line?.slice(LOGIN_PATH_MARKER.length);
            const directories = pathDirectories(path);
            return directories.length > 0 ? directories.join(delimiter) : undefined;
        } catch {
            return undefined;
        }
    }

    clear(): void {
        this.executableCache.clear();
        this.loginPathRequest = undefined;
        this.loginPathRequestedAt = 0;
    }

    async resolve(requestedExecutable: string): Promise<string | undefined> {
        const requested = requestedExecutable.trim();
        if (!requested || requested.length > 4_096 || requested.includes('\0')) return undefined;
        if (isAbsolute(requested)) return (await isExecutable(requested)) ? requested : undefined;
        if (requested.includes('/')) return undefined;

        const cached = this.executableCache.get(requested);
        if (cached && (await isExecutable(cached))) return cached;
        if (cached) {
            this.executableCache.delete(requested);
            /**
             * Re-read PATH after a cached install moved or was replaced while Caxri was running.
             */
            this.loginPathRequest = undefined;
        }

        const source = this.sourceEnvironment();
        const direct = await this.findInPath(requested, source.PATH);
        if (direct) return this.cache(requested, direct);
        const login = await this.loginPath();
        const discovered = await this.findInPath(requested, login);
        if (discovered) return this.cache(requested, discovered);
        if (this.now() - this.loginPathRequestedAt < LOGIN_PATH_REFRESH_MS) return undefined;
        this.loginPathRequest = undefined;
        const refreshed = await this.findInPath(requested, await this.loginPath());
        return refreshed ? this.cache(requested, refreshed) : undefined;
    }

    /**
     * A caller launching a child on behalf of an Agent passes that Agent's own variables; everything else takes the
     * Server's. Either way the login-shell PATH wins, because the Server's own PATH is whatever launchd gave the GUI.
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

/**
 * Fires the login-shell PATH probe without waiting for it (issue caxri#1345). `ExecutableResolver.loginPath()` memoizes
 * the in-flight request on the shared resolver, so the first real external command (often Git, from the Project Status
 * refresh moments after startup) reuses this request instead of paying its own login-shell spawn (~0.1s typically, up
 * to `LOGIN_SHELL_TIMEOUT_MS` on a slow shell profile) synchronously on the user's first action. `readLoginPath`
 * already catches its own failures and resolves `undefined`, so this can never produce an unhandled rejection.
 */
export function warmServerExecutablePath(): void {
    // eslint-disable-next-line no-void -- deliberate fire-and-forget; readLoginPath already catches its own failures
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
