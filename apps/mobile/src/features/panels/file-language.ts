/**
 * Prism grammars bundled with `prism-react-renderer`, keyed by file extension. A file outside this set previews as
 * plain text rather than borrowing a near-miss grammar.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    c: 'c',
    cc: 'cpp',
    cjs: 'javascript',
    cpp: 'cpp',
    css: 'css',
    cts: 'typescript',
    go: 'go',
    graphql: 'graphql',
    gql: 'graphql',
    h: 'c',
    hpp: 'cpp',
    htm: 'markup',
    html: 'markup',
    js: 'javascript',
    json: 'json',
    jsonc: 'json',
    jsx: 'jsx',
    kt: 'kotlin',
    kts: 'kotlin',
    m: 'objectivec',
    md: 'markdown',
    mdx: 'markdown',
    mjs: 'javascript',
    mts: 'typescript',
    py: 'python',
    rs: 'rust',
    sql: 'sql',
    svg: 'markup',
    swift: 'swift',
    ts: 'typescript',
    tsx: 'tsx',
    vue: 'markup',
    xml: 'markup',
    yaml: 'yaml',
    yml: 'yaml',
};

/**
 * @returns The Prism language for a file name, or `null` when it previews as plain text.
 */
export const fileLanguage = (name: string): string | null => {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
};
