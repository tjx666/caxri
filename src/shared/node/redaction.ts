import { homedir } from 'node:os';

/**
 * Node-only because it depends on `homedir()`; never import from src/renderer.
 * Shared by the structured logger and diagnostics export so credential-shaped
 * text is redacted identically wherever it is written to disk.
 */
const SECRET_KEY = /(token|password|secret|credential|api[_-]?key|authorization|cookie)/i;
const SECRET_ASSIGNMENT =
    /\b(token|password|secret|credential|api[_-]?key|authorization|cookie)\s*[=:]\s*([^\s,;]+)/gi;
const SECRET_VALUE =
    /(sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[a-zA-Z0-9._-]+|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{10,}|xox[baprs]-[a-zA-Z0-9-]{10,})/g;

/** True when a field name looks like it holds a credential. */
export function isSecretKey(key: string): boolean {
    return SECRET_KEY.test(key);
}

/** Redacts secret-shaped tokens and `key=value` assignments from free-form log text. */
export function redactLogValue(value: string): string {
    return value
        .replaceAll(homedir(), '$HOME')
        .replace(SECRET_VALUE, '[REDACTED]')
        .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]');
}

/** Recursively redacts secret-shaped keys and values from structured diagnostics data. */
export function redactSecrets(value: unknown, key = ''): unknown {
    if (isSecretKey(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([childKey, child]) => [
                childKey,
                redactSecrets(child, childKey),
            ]),
        );
    }
    if (typeof value === 'string') {
        return value.replaceAll(homedir(), '$HOME').replace(SECRET_VALUE, '[REDACTED]');
    }
    return value;
}
