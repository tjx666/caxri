/**
 * What a shell command did, when it is one of the file reads, searches, or listings an Agent runs to explore a Project.
 * The Codex app reads `sed -n '1,40p' src/app.ts` as `Read app.ts`, not as a command line, so a run of exploration
 * reads as what the Agent looked at.
 */
export type AgentShellCommandAction =
    | { kind: 'read'; paths: string[] }
    | { kind: 'search'; pattern: string; path?: string }
    | { kind: 'list'; path?: string };

const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'nl', 'bat', 'less', 'more']);
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'egrep', 'ag', 'ack']);
const LIST_COMMANDS = new Set(['ls', 'find', 'fd', 'tree', 'eza']);

/**
 * Commands that only reshape what an earlier pipeline stage printed, so `cat app.ts | head -40` is still a read.
 */
const FILTER_COMMANDS = new Set(['head', 'tail', 'nl', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed']);

/**
 * Options whose value is the next word, per command, so `head -n 40 app.ts` names `app.ts`, not `40`.
 */
const VALUE_OPTIONS: Partial<Record<string, ReadonlySet<string>>> = {
    head: new Set(['-n', '-c']),
    tail: new Set(['-n', '-c']),
    sed: new Set(['-e', '-f']),
    rg: new Set([
        '-g',
        '-t',
        '-T',
        '-A',
        '-B',
        '-C',
        '-m',
        '-e',
        '-f',
        '--glob',
        '--type',
        '--type-not',
        '--max-count',
        '--context',
        '--after-context',
        '--before-context',
    ]),
    grep: new Set(['-A', '-B', '-C', '-m', '-e', '-f', '--include', '--exclude']),
    find: new Set([
        '-name',
        '-iname',
        '-path',
        '-type',
        '-maxdepth',
        '-mindepth',
        '-newer',
        '-size',
    ]),
};

/**
 * Splits one simple command into words, honoring single and double quotes. Returns `null` for anything a word split
 * cannot read faithfully: a redirection, a substitution, or a variable.
 */
function splitWords(command: string): string[] | null {
    const words: string[] = [];
    let word = '';
    let hasWord = false;
    let quote: '"' | "'" | undefined;
    for (const char of command) {
        if (quote) {
            if (char === quote) quote = undefined;
            else word += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            hasWord = true;
            continue;
        }
        if (/[<>`$(){}]/u.test(char)) return null;
        if (/\s/u.test(char)) {
            if (hasWord) words.push(word);
            word = '';
            hasWord = false;
            continue;
        }
        word += char;
        hasWord = true;
    }
    if (quote) return null;
    if (hasWord) words.push(word);
    return words;
}

/**
 * Splits on unquoted pipeline and list operators. Returns `null` when the command chains anything but pipes after an
 * optional leading `cd <dir> &&`, which only sets where the rest runs.
 */
function splitStages(command: string): string[] | null {
    const parts: string[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;
    let index = 0;
    const separators: string[] = [];
    while (index < command.length) {
        const char = command[index] ?? '';
        if (quote) {
            if (char === quote) quote = undefined;
            current += char;
            index += 1;
            continue;
        }
        if (char === '"' || char === "'") quote = char;
        const operator = ['&&', '||', '|', ';'].find((op) => command.startsWith(op, index));
        if (operator && !quote) {
            parts.push(current.trim());
            separators.push(operator);
            current = '';
            index += operator.length;
            continue;
        }
        current += char;
        index += 1;
    }
    parts.push(current.trim());
    if (parts.includes('')) return null;
    // A leading `cd dir &&` only moves where the command runs.
    if (separators[0] === '&&' && /^cd\s/u.test(parts[0] ?? '')) {
        parts.shift();
        separators.shift();
    }
    return separators.every((separator) => separator === '|') ? parts : null;
}

/**
 * The positional words after the command name, skipping options and the values they take.
 */
function positionals(
    name: string,
    arguments_: readonly string[],
): { values: string[]; pattern?: string } {
    const valueOptions = VALUE_OPTIONS[name];
    const values: string[] = [];
    let pattern: string | undefined;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] ?? '';
        if (argument === '--') {
            values.push(...arguments_.slice(index + 1));
            break;
        }
        if (argument !== '-' && argument.startsWith('-')) {
            if (valueOptions?.has(argument)) {
                if (argument === '-e') pattern = arguments_.at(index + 1);
                index += 1;
            }
            continue;
        }
        values.push(argument);
    }
    return pattern === undefined ? { values } : { values, pattern };
}

function describeStage(words: readonly string[]): AgentShellCommandAction | null {
    const [name = '', ...arguments_] = words;
    const { values, pattern: optionPattern } = positionals(name, arguments_);
    if (READ_COMMANDS.has(name)) return values.length > 0 ? { kind: 'read', paths: values } : null;
    if (name === 'sed') {
        // Only `sed -n '1,40p' file` prints a file; any other script edits or transforms it.
        if (!arguments_.includes('-n') || arguments_.includes('-i')) return null;
        const paths = optionPattern === undefined ? values.slice(1) : values;
        return paths.length > 0 ? { kind: 'read', paths } : null;
    }
    if (SEARCH_COMMANDS.has(name)) {
        if (name === 'rg' && arguments_.includes('--files')) {
            const path = values.at(0);
            return path === undefined ? { kind: 'list' } : { kind: 'list', path };
        }
        const pattern = optionPattern ?? values.at(0);
        if (pattern === undefined) return null;
        const path = values.at(optionPattern === undefined ? 1 : 0);
        return path === undefined ? { kind: 'search', pattern } : { kind: 'search', pattern, path };
    }
    if (LIST_COMMANDS.has(name)) {
        const path = values.at(0);
        return path === undefined ? { kind: 'list' } : { kind: 'list', path };
    }
    return null;
}

/**
 * Reads a read, search, or listing out of an (already unwrapped) shell command; anything else returns `null` and stays
 * a plain `Ran …` row. Only the first pipeline stage acts; every later stage must be a filter such as `head`.
 */
export function describeShellCommand(command: string): AgentShellCommandAction | null {
    if (command.includes('\n')) return null;
    const stages = splitStages(command.trim());
    if (!stages) return null;
    const [first = '', ...rest] = stages;
    for (const stage of rest) {
        const words = splitWords(stage);
        if (!words?.[0] || !FILTER_COMMANDS.has(words[0])) return null;
    }
    const words = splitWords(first);
    return words && words.length > 0 ? describeStage(words) : null;
}
