import { homedir } from 'node:os';

import { execFileAsync, safeProcessEnvironment } from '@caxri/system';

import type { ExternalCommandDependencies } from '../executables';
import { runExternalCommand } from '../executables';
import { GitHubTokenCache } from './github-token';
import { LINEAR_TEAM_KEYS_QUERY } from './linear';

const CLI_TIMEOUT_MS = 8_000;
const CLI_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * Every external CLI the Server shells out to for delivery metadata. `git` is local, free, and never quota-governed;
 * the others answer to a remote API budget shared with everything else the user runs on this machine.
 */
export type ExternalStatusSource = 'gh' | 'git' | 'lh' | 'linear' | 'vc';

/**
 * The subset of {@link ExternalStatusSource} that a remote provider can rate limit, and therefore the subset
 * `ExternalStatusLimiter` tracks a circuit for.
 */
export type ExternalStatusQuotaSource = Exclude<ExternalStatusSource, 'git'>;

/**
 * The quota probe's GraphQL self-query. REST `/rate_limit` looks like the obvious source, but for the token class `gh`
 * uses its `resources.graphql` entry is a constant placeholder: `used` stays 0, `remaining` stays at `limit`, and
 * `reset` slides with the wall clock, so a reserve check built on it never fires (#917). Only the GraphQL `rateLimit`
 * object reports the budget the GraphQL calls actually draw on, and GitHub does not bill a query whose only field is
 * `rateLimit`.
 */
export const GITHUB_RATE_LIMIT_QUERY = 'query { rateLimit { limit remaining used resetAt } }';

export type CliFailureKind =
    | 'not-found'
    | 'not-logged-in'
    | 'not-linked'
    | 'permission-denied'
    | 'rate-limited'
    | 'timeout'
    | 'network'
    | 'tls'
    | 'other';

export type FailureReason = CliFailureKind | 'invalid-arguments' | 'no-pull-request';

export type ExternalStatusRunner = (
    source: ExternalStatusSource,
    arguments_: readonly string[],
    cwd: string,
) => Promise<string>;

export interface ExternalStatusCommandDependencies extends ExternalCommandDependencies {
    /**
     * The GitHub token source for `gh` calls; tests inject one, production shares one per process.
     */
    githubToken?: GitHubTokenCache;
}

export class ExternalStatusCliError extends Error {
    /**
     * Epoch ms when `ExternalStatusLimiter` will let this source run again. Only a `rate-limited` failure carries it,
     * and only when the limiter learned a reset: travelling on the error keeps the deadline with the one thing every
     * consumer already catches, instead of threading the limiter itself through each domain that reports the failure.
     */
    retryAt?: number;

    constructor(
        readonly command: ExternalStatusSource,
        readonly kind: CliFailureKind,
        message: string,
        readonly exitCode: number | null = null,
    ) {
        super(message);
    }
}

export function isNoPullRequest(error: unknown): boolean {
    return (
        error instanceof Error &&
        /no pull requests found|could not find pull request/i.test(error.message)
    );
}

/**
 * GitHub's secondary (abuse) limit clears in seconds and is reported separately from the primary hourly budget, so
 * pausing until the next hourly reset would idle the app for no reason. See
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits.
 */
export function isSecondaryRateLimit(message: string): boolean {
    return /abuse detection|secondary rate limit/i.test(message);
}

/**
 * Classifies diagnostics without recording CLI output. The command boundary also uses the network and TLS results so
 * Project Status can show a recovery action instead of a generic provider error.
 */
export function failureReason(error: unknown): FailureReason {
    if (isNoPullRequest(error)) return 'no-pull-request';
    if (error instanceof ExternalStatusCliError && error.kind !== 'other') return error.kind;
    const fault =
        error !== null && typeof error === 'object'
            ? (error as { message?: string; stderr?: string })
            : {};
    const message = fault.stderr?.length ? fault.stderr : (fault.message ?? '');
    if (
        /certificate|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|self.signed|TLS|SSL/i.test(
            message,
        )
    )
        return 'tls';
    if (
        /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|fetch failed|socket hang up/i.test(
            message,
        )
    )
        return 'network';
    if (
        /EACCES|EPERM|permission denied|forbidden|not authorized|access denied|HTTP 403/i.test(
            message,
        )
    )
        return 'permission-denied';
    if (
        /unknown (?:option|argument|flag)|invalid (?:option|argument|flag)|unexpected argument|requires? an argument/i.test(
            message,
        )
    )
        return 'invalid-arguments';
    return 'other';
}

function classifyCliFailure(
    source: ExternalStatusSource,
    /**
     * A caught value is not guaranteed to be an `Error` with a populated message.
     */
    error: { code?: string | number; killed?: boolean; message?: string; stderr?: string },
): CliFailureKind {
    if (error.code === 'ENOENT') return 'not-found';
    /*
     * `gh` documents exit code 4 as "authentication required". Under `CI=1` (always set for these spawns) it prints an
     * automation-specific message ("set the GH_TOKEN environment variable") instead of naming `gh auth login`, so the
     * exit code is the stable signal.
     */
    if (source === 'gh' && error.code === 4) return 'not-logged-in';
    const stderr = error.stderr?.length ? error.stderr : (error.message ?? '');
    const reason = failureReason(error);
    if (reason === 'network' || reason === 'tls') return reason;
    if (error.killed || /timed out/i.test(stderr)) return 'timeout';
    if (/rate limit|abuse detection/i.test(stderr)) return 'rate-limited';
    if (
        /*
         * `<name> login` rather than the literal `auth login`, because that is the one phrase every one of these CLIs
         * agrees on: it is how each tells the user to sign in, whether the verb is `gh auth login`, `lh login`, or
         * `vc login`. Matching only `auth login` sent a plainly signed-out LobeHub CLI ("No authentication found.
         * Run 'lh login' ... or set LOBEHUB_CLI_API_KEY.") down the `other` branch, where the panel could say nothing
         * more useful than "Something went wrong", instead of naming the one command that fixes it.
         */
        /auth(?:entication)? required|no authentication|set the GH_TOKEN environment variable|\b[\w-]+ login\b|not logged in|login required|no api key/i.test(
            stderr,
        )
    )
        return 'not-logged-in';
    if (/not linked|no project|run.*link|link this directory|not configured/i.test(stderr))
        return 'not-linked';
    /*
     * Signed in, but the account cannot see this resource: an organization enforcing SAML SSO the token was never
     * authorized for, a token missing a scope, or a plain 403. Checked after the rate limit because GitHub also answers
     * an exhausted budget with 403. The recovery is re-authorizing the token, which "Open Logs" would never suggest.
     */
    if (
        /SAML enforcement|\bSSO\b|required scopes|missing required scope|HTTP 403|forbidden|not authorized|access denied/i.test(
            stderr,
        )
    )
        return 'permission-denied';
    return 'other';
}

/**
 * Returns a content-free operation name for structured logs without exposing repository, branch, or issue values.
 */
export function externalStatusCommandOperation(
    source: ExternalStatusSource,
    arguments_: readonly string[],
): string {
    if (source === 'gh') {
        if (arguments_[0] === 'pr' && ['list', 'merge', 'view'].includes(arguments_[1]))
            return `pr.${arguments_[1]}`;
        if (arguments_[0] === 'repo' && arguments_[1] === 'view') return 'repo.view';
        // The quota probe is a fixed `rateLimit` self-query; its text is a literal, never user content.
        return arguments_[0] === 'api' &&
            arguments_[1] === 'graphql' &&
            arguments_[2] === '-f' &&
            arguments_[3] === `query=${GITHUB_RATE_LIMIT_QUERY}` &&
            arguments_.length === 4
            ? 'graphql.rate_limit'
            : 'unknown';
    }
    if (source === 'linear') {
        if (arguments_[0] !== 'api') return 'unknown';
        // The allow-list query is the more frequent of the two spawns; folding it into `issue.get` would make the
        // Linear quota log unable to answer where the quota actually went. Its text is a literal, never user content.
        return arguments_[1] === LINEAR_TEAM_KEYS_QUERY ? 'team_keys.list' : 'issue.get';
    }
    if (source === 'lh')
        return arguments_[0] === 'acceptance' && arguments_[1] === 'view'
            ? 'acceptance.get'
            : 'unknown';
    if (source === 'vc') return arguments_[0] === 'teams' ? 'teams.list' : 'deployments.list';
    if (arguments_[0] === 'remote') return 'remote.get-url';
    if (arguments_[0] === 'symbolic-ref') return 'default-branch.get';
    if (arguments_[0] === 'for-each-ref') return 'head.get';
    return 'unknown';
}

function externalStatusCliError(
    source: ExternalStatusSource,
    error: unknown,
): ExternalStatusCliError {
    if (error instanceof ExternalStatusCliError) return error;
    const failure = (error !== null && typeof error === 'object' ? error : {}) as {
        code?: string | number;
        killed?: boolean;
        stderr?: string;
        message?: string;
    };
    return new ExternalStatusCliError(
        source,
        classifyCliFailure(source, failure),
        // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty stderr also carries no useful detail
        failure.stderr || failure.message || 'External status command failed',
        typeof failure.code === 'number' && Number.isSafeInteger(failure.code) && failure.code >= 0
            ? failure.code
            : null,
    );
}

async function runCli(
    source: Exclude<ExternalStatusSource, 'git'>,
    arguments_: readonly string[],
    cwd: string,
    dependencies: ExternalStatusCommandDependencies,
    extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<string> {
    const { stdout } = await runExternalCommand(
        source,
        arguments_,
        {
            cwd,
            timeout: CLI_TIMEOUT_MS,
            maxBuffer: CLI_MAX_BUFFER_BYTES,
            env: {
                CI: '1',
                LC_ALL: 'C',
                ...(source === 'linear' && {
                    /**
                     * `@schpet/linear-cli` 2.5.0 loads LINEAR_API_KEY from the repository's `.env` when the variable is
                     * absent. An explicit empty value preserves dotenv's existing-own-property guard, blocking that
                     * fallback while keeping Server's credential filter and the user's configured workspace credentials
                     * authoritative.
                     */
                    LINEAR_API_KEY: '',
                }),
                ...extraEnvironment,
            },
        },
        dependencies,
    );
    return stdout;
}

/**
 * Only a failure that may have been a Keychain prompt (an unrecognized error, or a dialog left unanswered until the
 * timeout) earns the long backoff. Every other failure raised no dialog, so `gh` is asked again a minute later.
 */
function isGitHubTokenQuickRecheck(error: unknown): boolean {
    const { kind } = externalStatusCliError('gh', error);
    return kind !== 'other' && kind !== 'timeout';
}

function gitHubTokenCacheFor(dependencies: ExternalStatusCommandDependencies): GitHubTokenCache {
    return new GitHubTokenCache(
        () => runCli('gh', ['auth', 'token'], homedir(), dependencies),
        isGitHubTokenQuickRecheck,
    );
}

/**
 * The process-wide token cache behind every production `gh` call; see {@link GitHubTokenCache}.
 */
const defaultGitHubToken = gitHubTokenCacheFor({});

async function runGitHubCli(
    arguments_: readonly string[],
    cwd: string,
    dependencies: ExternalStatusCommandDependencies,
): Promise<string> {
    const tokens =
        dependencies.githubToken ??
        (dependencies.run || dependencies.resolveExecutable || dependencies.environment
            ? gitHubTokenCacheFor(dependencies)
            : defaultGitHubToken);
    const read = await tokens.read();
    if (read.kind === 'parked') throw externalStatusCliError('gh', read.error);
    try {
        return await runCli('gh', arguments_, cwd, dependencies, { GH_TOKEN: read.token });
    } catch (error) {
        const failure = externalStatusCliError('gh', error);
        if (failure.kind === 'not-logged-in' || /HTTP 401|Bad credentials/i.test(failure.message))
            tokens.invalidate(read.token);
        throw failure;
    }
}

export async function runExternalStatusCommand(
    source: ExternalStatusSource,
    arguments_: readonly string[],
    cwd: string,
    dependencies: ExternalStatusCommandDependencies = {},
): Promise<string> {
    try {
        if (source === 'git') {
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
        if (source === 'gh') return await runGitHubCli(arguments_, cwd, dependencies);
        return await runCli(source, arguments_, cwd, dependencies);
    } catch (error) {
        throw externalStatusCliError(source, error);
    }
}
