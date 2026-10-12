/**
 * Quotes one value for a POSIX `sh` command line by wrapping it in single quotes, where every byte is literal, and
 * splicing each embedded single quote as `'\''`. This is the only way a value reaches a remote script in this module,
 * so a path, URL, or hash can never terminate the quoting or inject a command.
 *
 * NUL is refused because no shell word can carry it; the caller passes such data on stdin instead.
 */
export function shellQuote(value: string): string {
    if (value.includes('\0')) throw new Error('Shell values must not contain NUL');
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
