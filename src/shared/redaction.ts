const SECRET_KEY = /(token|password|secret|credential|api[_-]?key|authorization|cookie)/i;
const SECRET_ASSIGNMENT =
    /((?:"(?:token|password|secret|credential|api[_-]?key|authorization|cookie)"|'(?:token|password|secret|credential|api[_-]?key|authorization|cookie)'|\b(?:token|password|secret|credential|api[_-]?key|authorization|cookie)\b)\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi;
const SECRET_VALUE =
    /(sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[a-zA-Z0-9._-]+|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{10,}|xox[baprs]-[a-zA-Z0-9-]{10,})/g;
const URL = /https?:\/\/[^\s<>"']+/gi;
const PRESIGNED_QUERY_PARAMETER =
    /(?:^|&)(?:x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|signature|sig)=/i;

/** Presigned URLs are credentials, so retaining unrelated query fields still leaks access scope. */
function redactPresignedUrl(value: string): string {
    const queryStart = value.indexOf('?');
    if (queryStart < 0) return value;
    const fragmentStart = value.indexOf('#', queryStart);
    const queryEnd = fragmentStart < 0 ? value.length : fragmentStart;
    if (!PRESIGNED_QUERY_PARAMETER.test(value.slice(queryStart + 1, queryEnd))) return value;
    const fragment = fragmentStart < 0 ? '' : value.slice(fragmentStart);
    return `${value.slice(0, queryStart)}?[REDACTED]${fragment}`;
}

/** Browser-safe subset shared by diagnostics and user-previewed bug reports. */
export function redactSecretText(value: string): string {
    return value
        .replace(URL, redactPresignedUrl)
        .replace(SECRET_VALUE, '[REDACTED]')
        .replace(SECRET_ASSIGNMENT, (_match, prefix: string, secret: string) => {
            const quote =
                (secret.startsWith('"') && secret.endsWith('"')) ||
                (secret.startsWith("'") && secret.endsWith("'"))
                    ? secret[0]
                    : '';
            return `${prefix}${quote}[REDACTED]${quote}`;
        });
}

/** True when a field name looks like it holds a credential. */
export function isSecretKey(key: string): boolean {
    return SECRET_KEY.test(key);
}
