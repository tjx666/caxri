/**
 * The one credential-name vocabulary shared by object keys, `key=value` text, and command-line flags, so a name added
 * here is redacted in every shape at once.
 */
const SECRET_NAME = 'token|password|secret|credential|api[_-]?key|authorization|cookie';
const SECRET_KEY = new RegExp(SECRET_NAME, 'i');
const SECRET_ASSIGNMENT = new RegExp(
    String.raw`((?:"(?:${SECRET_NAME})"|'(?:${SECRET_NAME})'|\b(?:${SECRET_NAME}))\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)`,
    'gi',
);
/**
 * A whole flag token whose name carries the credential vocabulary (`--api-key`, `--github-token`, `-password`).
 */
const SECRET_FLAG = String.raw`-[\w-]*(?:${SECRET_NAME})[\w-]*`;
/**
 * A secret flag at the start of a token plus its `=value`, whitespace-separated value, or quoted value. A separated
 * value that is itself a secret flag is not consumed: `--skip-password-prompt --password value` must leave the second
 * flag to match on its own, otherwise its real value would stay visible.
 */
const SECRET_FLAG_IN_COMMAND = new RegExp(
    String.raw`(?<!\S)(${SECRET_FLAG})(?:=|\s+(?!${SECRET_FLAG}(?:[=\s]|$)))(?:"[^"]*"|'[^']*'|\S+)`,
    'giu',
);
const SECRET_FLAG_ONLY = new RegExp(`^${SECRET_FLAG}$`, 'iu');
const SECRET_FLAG_START = new RegExp(String.raw`^${SECRET_FLAG}(?:[=\s]|$)`, 'iu');
const SECRET_FLAG_ASSIGNMENT = new RegExp(`^(${SECRET_FLAG})=`, 'iu');
const REDACTED = '[REDACTED]';
const SECRET_VALUE =
    /sk-[\w-]{12,}|Bearer\s+[\w.-]+|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_\w{10,}|xox[baprs]-[a-zA-Z0-9-]{10,}/g;
/**
 * Not named `URL`: bundlers hoist this module into the Renderer's top-level scope, where that name can shadow the
 * global `URL` constructor that asset imports (`new URL(asset, import.meta.url)`) rely on.
 */
const URL_PATTERN = /(?:https?|ssh|git|ftps?):\/\/[^\s<>"']+/gi;
/**
 * The `user:password@` or `token@` authority prefix of a URL. The userinfo ends at the last `@` before the first path,
 * query, or fragment delimiter.
 */
const URL_USERINFO = /^([a-z][a-z\d+.-]*:\/\/)[^\s/?#]*@/i;
const PRESIGNED_QUERY_PARAMETER =
    /(?:^|&)(?:x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|signature|sig)=/i;

/**
 * Presigned URLs are credentials, so retaining unrelated query fields still leaks access scope.
 */
function redactPresignedUrl(value: string): string {
    const queryStart = value.indexOf('?');
    if (queryStart === -1) return value;
    const fragmentStart = value.indexOf('#', queryStart);
    const queryEnd = fragmentStart === -1 ? value.length : fragmentStart;
    if (!PRESIGNED_QUERY_PARAMETER.test(value.slice(queryStart + 1, queryEnd))) return value;
    const fragment = fragmentStart === -1 ? '' : value.slice(fragmentStart);
    return `${value.slice(0, queryStart)}?[REDACTED]${fragment}`;
}

/**
 * Embedded userinfo credentials (`https://user:password@host`, `https://token@host`) are secrets, so the whole userinfo
 * is replaced while the scheme, host, and path stay readable.
 */
function redactUrlUserinfo(value: string): string {
    return value.replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${REDACTED}@`);
}

/**
 * Browser-safe subset shared by diagnostics and user-previewed bug reports.
 */
export function redactSecretText(value: string): string {
    return value
        .replaceAll(URL_PATTERN, (match) => redactPresignedUrl(redactUrlUserinfo(match)))
        .replaceAll(SECRET_VALUE, '[REDACTED]')
        .replaceAll(SECRET_ASSIGNMENT, (_match, prefix: string, secret: string) => {
            const quote =
                (secret.startsWith('"') && secret.endsWith('"')) ||
                (secret.startsWith("'") && secret.endsWith("'"))
                    ? secret[0]
                    : '';
            return `${prefix}${quote}[REDACTED]${quote}`;
        });
}

/**
 * True when a field name looks like it holds a credential.
 */
export function isSecretKey(key: string): boolean {
    return SECRET_KEY.test(key);
}

/**
 * Hides the value of every credential-named flag in a flattened command line (`ps` output, a configured command) while
 * keeping the executable and the remaining argv readable. Each match is rewritten as `--flag=<replacement>`.
 */
export function redactCommandLine(command: string, replacement = REDACTED): string {
    return command.replaceAll(SECRET_FLAG_IN_COMMAND, (_match, flag: string) => {
        return `${flag}=${replacement}`;
    });
}

/**
 * Argv counterpart of {@link redactCommandLine}. Array elements carry no key for `redactSecrets` to recognize, so a
 * value stored as the element after `--api-key` would otherwise survive verbatim. The element following a bare secret
 * flag is replaced whole (it may legitimately contain spaces), an inline `--flag=value` loses its entire value, and an
 * element that is itself a persisted command-line fragment (`--token abc`) goes through the command-line rule.
 */
export function redactArgv(arguments_: readonly string[], replacement = REDACTED): string[] {
    let isValueExpected = false;
    return arguments_.map((argument) => {
        const isValue = isValueExpected && !SECRET_FLAG_START.test(argument);
        isValueExpected = SECRET_FLAG_ONLY.test(argument.trim().split(/\s+/u).at(-1) ?? '');
        if (isValue) return replacement;
        const assignment = SECRET_FLAG_ASSIGNMENT.exec(argument);
        return assignment
            ? `${assignment[1]}=${replacement}`
            : redactCommandLine(argument, replacement);
    });
}
