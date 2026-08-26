import type { ProjectStatusDeployment, ProjectStatusError } from '@caxri/protocol';

import { execFileAsync } from '../shared/node/exec';
import { safeProcessEnvironment } from '../shared/node/process-environment';
import type { ExternalCommandDependencies } from './executables';
import { runExternalCommand } from './executables';

const CLI_TIMEOUT_MS = 8_000;
const CLI_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export type ProjectStatusCommand = 'gh' | 'git' | 'linear' | 'vc';
export type CliFailureKind =
    'not-found' | 'not-logged-in' | 'not-linked' | 'rate-limited' | 'timeout' | 'other';

export type ProjectStatusRunner = (
    command: ProjectStatusCommand,
    arguments_: readonly string[],
    cwd: string,
) => Promise<string>;

export type ProjectStatusCommandDependencies = ExternalCommandDependencies;

export interface VercelLink {
    project: string;
    team: string;
}

interface LinearReference {
    identifier: string;
    workspace?: string;
}

const REFERENCE_MARKERS = [
    'Fix',
    'Fixes',
    'Fixed',
    'Close',
    'Closes',
    'Closed',
    'Resolve',
    'Resolves',
    'Resolved',
    'Related to',
] as const;

export class ProjectStatusCliError extends Error {
    constructor(
        readonly command: ProjectStatusCommand,
        readonly kind: CliFailureKind,
        message: string,
    ) {
        super(message);
    }
}

export function projectStatusCliError(
    command: ProjectStatusCommand,
    kind: CliFailureKind,
): ProjectStatusError {
    const source = command === 'gh' ? 'github' : command === 'vc' ? 'vercel' : 'linear';
    if (kind === 'not-found') {
        return {
            source,
            message: `${command} not installed`,
            hint:
                command === 'gh'
                    ? 'Install GitHub CLI to load pull requests.'
                    : command === 'vc'
                      ? 'Install Vercel CLI to load deployments.'
                      : 'Install linear-cli to load linked issues.',
        };
    }
    if (kind === 'not-logged-in') {
        return {
            source,
            message: `${command}: not logged in`,
            hint: `Run \`${command} ${command === 'vc' ? 'login' : 'auth login'}\` in a Terminal.`,
        };
    }
    if (kind === 'not-linked') {
        return {
            source,
            message: `${command}: not linked`,
            hint:
                command === 'vc'
                    ? 'Run `vc link` in the repository.'
                    : 'Run `linear config` in the repository.',
        };
    }
    if (kind === 'rate-limited')
        return {
            source,
            message: `${command}: rate limited`,
            hint: 'Refresh after the API limit resets.',
        };
    if (kind === 'timeout')
        return {
            source,
            message: `${command} timed out`,
            hint: 'Check the network or proxy, then refresh.',
        };
    return {
        source,
        message: `${command}: error`,
        hint: 'See Runtime logs for details.',
        detailsView: 'logs',
    };
}

export function isNoPullRequest(error: unknown): boolean {
    return (
        error instanceof Error &&
        /no pull requests found|could not find pull request/i.test(error.message)
    );
}

export function parseGitHubRemote(value: string): { owner: string; repo: string } | undefined {
    const match = value
        .trim()
        .replace(/\/$/, '')
        .replace(/\.git$/, '')
        .match(/github\.com[:/]([^/\s]+)\/([^/\s]+)$/i);
    return match ? { owner: match[1], repo: match[2] } : undefined;
}

export function extractLinearReferences(body: string): LinearReference[] {
    const references: LinearReference[] = [];
    const add = (identifier: string, workspace?: string): void => {
        const normalized = identifier.toUpperCase();
        if (references.some((candidate) => candidate.identifier === normalized)) return;
        references.push({ identifier: normalized, workspace: workspace?.toLowerCase() });
    };
    for (const match of body.matchAll(
        /https?:\/\/linear\.app\/([a-z0-9-]+)\/issue\/([a-z][a-z0-9]*-[1-9]\d*)/giu,
    )) {
        add(match[2], match[1]);
    }
    const markerPattern = REFERENCE_MARKERS.map((marker) =>
        marker.replaceAll(' ', String.raw`\s+`),
    ).join('|');
    const referenceLine = new RegExp(String.raw`(?:^|\b)(?:${markerPattern})\b([^\n]*)`, 'giu');
    for (const marker of body.matchAll(referenceLine)) {
        const identifiers = marker[1].matchAll(/\b([a-z][a-z0-9]*-[1-9]\d*)\b/giu);
        for (const identifier of identifiers) add(identifier[1]);
    }
    return references;
}

function classifyCliFailure(
    /**
     * A caught value is not guaranteed to be an `Error` with a populated message.
     */
    error: { code?: string; killed?: boolean; message?: string; stderr?: string },
): CliFailureKind {
    if (error.code === 'ENOENT') return 'not-found';
    const stderr = error.stderr ?? error.message ?? '';
    if (error.killed || /timed out/i.test(stderr)) return 'timeout';
    if (/rate limit|abuse detection/i.test(stderr)) return 'rate-limited';
    if (
        /auth(?:entication)? required|auth login|not logged in|login required|no api key/i.test(
            stderr,
        )
    )
        return 'not-logged-in';
    if (/not linked|no project|run.*link|link this directory|not configured/i.test(stderr))
        return 'not-linked';
    return 'other';
}

/**
 * Returns a content-free operation name for structured logs without exposing repository, branch, or issue values.
 */
export function projectStatusCommandOperation(
    command: ProjectStatusCommand,
    arguments_: readonly string[],
): string {
    if (command === 'gh') return arguments_[0] === 'pr' ? 'pr.view' : 'unknown';
    if (command === 'linear') return arguments_[0] === 'api' ? 'issue.get' : 'unknown';
    if (command === 'vc') return arguments_[0] === 'teams' ? 'teams.list' : 'deployments.list';
    if (arguments_[0] === 'remote') return 'remote.get-url';
    if (arguments_[0] === 'symbolic-ref') return 'default-branch.get';
    if (arguments_[0] === 'rev-parse') return 'head.get';
    return 'unknown';
}

/**
 * Maintains an insertion-ordered LRU cache for repository-to-Vercel links.
 */
export function rememberVercelLink(
    links: Map<string, VercelLink>,
    key: string,
    value: VercelLink,
    maximum: number,
): void {
    links.delete(key);
    links.set(key, value);
    while (links.size > Math.max(1, maximum)) {
        const oldest = links.keys().next().value;
        if (!oldest) break;
        links.delete(oldest);
    }
}

export function vcListArguments(
    team: string,
    meta: Record<string, string>,
    environment?: ProjectStatusDeployment['environment'],
): string[] {
    const arguments_ = ['ls', '--format', 'json', '--scope', team];
    for (const [key, value] of Object.entries(meta)) arguments_.push('--meta', `${key}=${value}`);
    if (environment) arguments_.push('--environment', environment);
    arguments_.push('--yes');
    return arguments_;
}

export async function runProjectStatusCommand(
    command: ProjectStatusCommand,
    arguments_: readonly string[],
    cwd: string,
    dependencies: ProjectStatusCommandDependencies = {},
): Promise<string> {
    try {
        if (command === 'git') {
            // `git` ships with macOS, so it skips login-shell resolution and stays on the sanitized
            // base environment.
            const run = dependencies.run ?? execFileAsync;
            const { stdout } = await run('git', [...arguments_], {
                cwd,
                timeout: CLI_TIMEOUT_MS,
                maxBuffer: CLI_MAX_BUFFER_BYTES,
                env: { ...safeProcessEnvironment(), CI: '1', LC_ALL: 'C' },
            });
            return stdout;
        }
        const { stdout } = await runExternalCommand(
            command,
            arguments_,
            {
                cwd,
                timeout: CLI_TIMEOUT_MS,
                maxBuffer: CLI_MAX_BUFFER_BYTES,
                env: {
                    CI: '1',
                    LC_ALL: 'C',
                    ...(command === 'linear' && {
                        /**
                         * `@schpet/linear-cli` 2.5.0 loads LINEAR_API_KEY from the repository's `.env` when the
                         * variable is absent. An explicit empty value preserves dotenv's existing-own-property guard,
                         * blocking that fallback while keeping Runtime's credential filter and the user's configured
                         * workspace credentials authoritative.
                         */
                        LINEAR_API_KEY: '',
                    }),
                },
            },
            dependencies,
        );
        return stdout;
    } catch (error) {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
        throw new ProjectStatusCliError(
            command,
            classifyCliFailure(failure),
            // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty stderr also carries no useful detail
            failure.stderr || failure.message,
        );
    }
}
