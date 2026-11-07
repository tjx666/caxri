/**
 * Path codec for a virtual editor tab whose identity is one Terminal: `<scheme>://<encoded terminal id>`. The id is
 * percent-encoded so a separator inside it can never be read as a second path segment.
 */
export function terminalTabPathCodec(prefix: `${string}://`) {
    const parse = (path: string): { terminalId: string } | undefined => {
        if (!path.startsWith(prefix)) return undefined;
        const encoded = path.slice(prefix.length);
        if (!encoded || encoded.includes('/')) return undefined;
        try {
            return { terminalId: decodeURIComponent(encoded) };
        } catch {
            return undefined;
        }
    };
    return {
        path: (terminalId: string): string => `${prefix}${encodeURIComponent(terminalId)}`,
        parse,
        is: (path: string): boolean => Boolean(parse(path)),
    };
}
