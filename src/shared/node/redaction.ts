import { homedir } from 'node:os';

import { isSecretKey, redactSecretText } from '../redaction';

/**
 * Node-only because it depends on `homedir()`; never import from apps/desktop/src/renderer. Shared by the structured
 * logger and diagnostics export so credential-shaped text is redacted identically wherever it is written to disk.
 */
export { isSecretKey } from '../redaction';

/**
 * Redacts secret-shaped tokens and `key=value` assignments from free-form log text.
 */
export function redactLogValue(value: string): string {
    return redactSecretText(value.replaceAll(homedir(), '$HOME'));
}

/**
 * Recursively redacts secret-shaped keys and values from structured diagnostics data.
 */
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
        return redactSecretText(value.replaceAll(homedir(), '$HOME'));
    }
    return value;
}
