import { execFileAsync, safeProcessEnvironment } from '@caxri/system';

import type { ExternalCommandDependencies } from '../executables';
import { runExternalCommand } from '../executables';

const CLI_TIMEOUT_MS = 8_000;
const CLI_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * Every external CLI the Server shells out to for delivery metadata. `git` is local, free, and never quota-governed;
 * the other three answer to a remote API budget shared with everything else the user runs on this machine.
 */
export type ExternalStatusSource = 'gh' | 'git' | 'linear' | 'vc';

/**
 * The subset of {@link ExternalStatusSource} that a remote provider can rate limit, and therefore the subset
 * `ExternalStatusLimiter` tracks a circuit for.
 */
export type ExternalStatusQuotaSource = Exclude<ExternalStatusSource, 'git'>;

export type CliFailureKind =
    | 'not-found'
    | 'not-logged-in'
    | 'not-linked'
    | 'rate-limited'
    | 'timeout'
    | 'network'
    | 'tls'
    | 'other';

export type FailureReason =
    CliFailureKind | 'permission-denied' | 'invalid-arguments' | 'no-pull-request';

export type ExternalStatusRunner = (
    source: ExternalStatusSource,
    arguments_: readonly string[],
    cwd: string,
) => Promise<string>;

export type ExternalStatusCommandDependencies = ExternalCommandDependencies;

export class ExternalStatusCliError extends Error {
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
    /**
     * A caught value is not guaranteed to be an `Error` with a populated message.
     */
    error: { code?: string | number; killed?: boolean; message?: string; stderr?: string },
): CliFailureKind {
    if (error.code === 'ENOENT') return 'not-found';
    const stderr = error.stderr?.length ? error.stderr : (error.message ?? '');
    const reason = failureReason(error);
    if (reason === 'network' || reason === 'tls') return reason;
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
export function externalStatusCommandOperation(
    source: ExternalStatusSource,
    arguments_: readonly string[],
): string {
    if (source === 'gh') {
        if (arguments_[0] === 'pr' && ['list', 'view'].includes(arguments_[1]))
            return `pr.${arguments_[1]}`;
        // `gh api rate_limit` is the quota probe; its endpoint is a fixed literal, never user content.
        return arguments_[0] === 'api' && arguments_[1] === 'rate_limit'
            ? 'api.rate_limit'
            : 'unknown';
    }
    if (source === 'linear') return arguments_[0] === 'api' ? 'issue.get' : 'unknown';
    if (source === 'vc') return arguments_[0] === 'teams' ? 'teams.list' : 'deployments.list';
    if (arguments_[0] === 'remote') return 'remote.get-url';
    if (arguments_[0] === 'symbolic-ref') return 'default-branch.get';
    if (arguments_[0] === 'rev-parse') return 'head.get';
    return 'unknown';
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
                         * `@schpet/linear-cli` 2.5.0 loads LINEAR_API_KEY from the repository's `.env` when the
                         * variable is absent. An explicit empty value preserves dotenv's existing-own-property guard,
                         * blocking that fallback while keeping Server's credential filter and the user's configured
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
        const failure = (error !== null && typeof error === 'object' ? error : {}) as {
            code?: string | number;
            killed?: boolean;
            stderr?: string;
            message?: string;
        };
        throw new ExternalStatusCliError(
            source,
            classifyCliFailure(failure),
            // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty stderr also carries no useful detail
            failure.stderr || failure.message || 'External status command failed',
            typeof failure.code === 'number' &&
                Number.isSafeInteger(failure.code) &&
                failure.code >= 0
                ? failure.code
                : null,
        );
    }
}
