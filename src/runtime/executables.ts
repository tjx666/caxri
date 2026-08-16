import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { promisify, stripVTControlCharacters } from 'node:util';

import { safeProcessEnvironment } from '../shared/node/process-environment';

const execFileAsync = promisify(execFile);
const LOGIN_PATH_MARKER = '__CAXRI_LOGIN_PATH__';
const MAX_LOGIN_PATH_BYTES = 32 * 1024;
const LOGIN_SHELL_TIMEOUT_MS = 5_000;
const MAX_EXECUTABLE_CACHE_ENTRIES = 32;

type RunFile = (
    executable: string,
    arguments_: string[],
    options: {
        env: NodeJS.ProcessEnv;
        maxBuffer: number;
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
    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
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

    constructor(
        private readonly sourceEnvironment: () => NodeJS.ProcessEnv = () => process.env,
        private readonly run: RunFile = runFile,
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
        this.loginPathRequest ??= this.readLoginPath();
        return this.loginPathRequest;
    }

    private async readLoginPath(): Promise<string | undefined> {
        const source = this.sourceEnvironment();
        // `||` (not `??`) is deliberate: `SHELL=''` is not a runnable shell either and must also
        // fall back to the default.
        // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is not a valid shell path either
        const shell = source.SHELL || '/bin/zsh';
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
        return discovered ? this.cache(requested, discovered) : undefined;
    }

    async environment(): Promise<NodeJS.ProcessEnv> {
        const source = this.sourceEnvironment();
        const loginPath = await this.loginPath();
        return {
            ...safeProcessEnvironment(source),
            ...(loginPath && { PATH: loginPath }),
        };
    }
}

const runtimeExecutableResolver = new ExecutableResolver();

export function clearRuntimeExecutableCache(): void {
    runtimeExecutableResolver.clear();
}

export function resolveRuntimeExecutable(name: string): Promise<string | undefined> {
    return runtimeExecutableResolver.resolve(name);
}

export function runtimeProcessEnvironment(): Promise<NodeJS.ProcessEnv> {
    return runtimeExecutableResolver.environment();
}
