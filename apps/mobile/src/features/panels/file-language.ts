/**
 * Prism grammars bundled with `prism-react-renderer` or registered in `components/prism-grammars.ts`, keyed by file
 * extension. A file outside this set previews as plain text rather than borrowing a near-miss grammar.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    bash: 'bash',
    c: 'c',
    cc: 'cpp',
    cjs: 'javascript',
    cpp: 'cpp',
    css: 'css',
    diff: 'diff',
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
    patch: 'diff',
    py: 'python',
    rs: 'rust',
    sh: 'bash',
    shell: 'bash',
    sql: 'sql',
    svg: 'markup',
    swift: 'swift',
    ts: 'typescript',
    tsx: 'tsx',
    vue: 'markup',
    xml: 'markup',
    yaml: 'yaml',
    yml: 'yaml',
    zsh: 'bash',
};

/**
 * @returns The Prism language for a file name, or `null` when it previews as plain text.
 */
export const fileLanguage = (name: string): string | null => {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
};

/**
 * The Prism language for a language id an Agent Chat client infers for output (`agentChatOutputLanguage`): a file
 * extension, `diff`, `json`, or `shell`. `null` paints plain text.
 */
export const codeLanguage = (id: string | undefined): string | null =>
    id === undefined ? null : (LANGUAGE_BY_EXTENSION[id.toLowerCase()] ?? null);

/**
 * Every Prism language the map above can name, so a fence may use the language's own name (`typescript`, `python`).
 */
const PRISM_LANGUAGES = new Set(Object.values(LANGUAGE_BY_EXTENSION));

/**
 * Common fence names that are neither a file extension nor a Prism language id.
 */
const FENCE_ALIASES: Record<string, string> = {
    golang: 'go',
    html: 'markup',
    objc: 'objectivec',
    console: 'bash',
};

/**
 * The Prism language for a Markdown fence's info string (````ts title="a.ts"`): its first word, read as a file
 * extension (`ts`, `sh`), a Prism language name (`typescript`), or a common alias (`golang`). `null` keeps the block
 * plain, including a fence with no language or one the phone bundles no grammar for.
 */
export const fenceLanguage = (info: string | undefined): string | null => {
    const id = info?.trim().split(/\s+/u, 1)[0]?.toLowerCase();
    if (!id) return null;
    return (
        LANGUAGE_BY_EXTENSION[id] ?? (PRISM_LANGUAGES.has(id) ? id : (FENCE_ALIASES[id] ?? null))
    );
};
