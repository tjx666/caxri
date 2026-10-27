import { execFileSync } from 'node:child_process';

export interface EmbeddedFormatRequest {
    /**
     * Directory whose `bunfig.toml` `[fmt]` section supplies the repository formatting options.
     */
    readonly cwd: string;
    readonly parser: string;
    readonly printWidth: number;
    readonly source: string;
}

const cache = new Map<string, string | undefined>();

/**
 * Formats a code fragment the way the repository formatter formats a whole file, or returns `undefined` when the
 * fragment does not parse.
 *
 * `prettier-plugin-jsdoc` formats `@example` code, fenced code, tables, and tag types by calling Prettier. Calling `bun
 * fmt` instead keeps one formatter for both files and the code inside their comments. ESLint rules are synchronous, so
 * this is a deliberately synchronous child process; results are cached per process because the same fragments recur
 * across lint runs of one file and every fragment is pure input.
 */
export function formatEmbedded({
    cwd,
    parser,
    printWidth,
    source,
}: EmbeddedFormatRequest): string | undefined {
    const key = `${cwd}\0${parser}\0${printWidth}\0${source}`;
    if (cache.has(key)) return cache.get(key);
    let formatted: string | undefined;
    try {
        // oxlint-disable-next-line node/no-sync -- ESLint rules are synchronous; see the JSDoc above.
        formatted = execFileSync(
            'bun',
            [
                'fmt',
                '--no-config',
                '--no-script',
                '--log-level',
                'silent',
                '--parser',
                parser,
                '--print-width',
                String(printWidth),
            ],
            { cwd, encoding: 'utf8', input: source, stdio: ['pipe', 'pipe', 'ignore'] },
        );
    } catch {
        formatted = undefined;
    }
    cache.set(key, formatted);
    return formatted;
}
