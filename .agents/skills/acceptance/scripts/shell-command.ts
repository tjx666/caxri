/**
 * A small shell lexer shared by the project PreToolUse hook. It finds the executable commands in a Bash tool call,
 * including commands nested in wrappers and command substitutions, without evaluating anything. It must stay free of
 * workspace dependencies because the hook also runs in checkouts without `node_modules`.
 */

interface HereDocument {
    delimiter: string;
    stripTabs: boolean;
}

export interface ShellToken {
    kind: 'redirect' | 'word';
    value: string;
}

const SHELL_OPTION_VALUE_NAMES = new Set([
    '--chdir',
    '--split-string',
    '--unset',
    '-C',
    '-S',
    '-u',
]);

const SHELL_CONTROL_PREFIXES = new Set([
    '!',
    '{',
    'do',
    'elif',
    'else',
    'if',
    'then',
    'until',
    'while',
]);
const EXEC_OPTIONS_WITH_VALUE = new Set(['-a']);
const NICE_OPTIONS_WITH_VALUE = new Set(['--adjustment', '-n']);
const NO_OPTIONS_WITH_VALUE = new Set<string>();
const SETSID_EXECUTING_FLAGS = new Set(['--ctty', '--fork', '--wait', '-c', '-f', '-w']);
const SIMPLE_EXECUTION_WRAPPERS = new Set(['nohup', 'parallel']);
const SUDO_EXECUTING_FLAGS = new Set([
    '--askpass',
    '--background',
    '--login',
    '--non-interactive',
    '--preserve-env',
    '--preserve-groups',
    '--set-home',
    '--shell',
    '--stdin',
    '-A',
    '-b',
    '-E',
    '-H',
    '-i',
    '-n',
    '-P',
    '-s',
    '-S',
]);
const SUDO_OPTIONS_WITH_VALUE = new Set([
    '--chdir',
    '--chroot',
    '--close-from',
    '--group',
    '--host',
    '--other-user',
    '--prompt',
    '--role',
    '--type',
    '--user',
    '-C',
    '-D',
    '-g',
    '-h',
    '-p',
    '-R',
    '-r',
    '-t',
    '-u',
]);
const TIME_OPTIONS_WITH_VALUE = new Set(['--format', '--output', '-f', '-o']);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(['--kill-after', '--signal', '-k', '-s']);
const XARGS_OPTIONS_WITH_VALUE = new Set([
    '--arg-file',
    '--delimiter',
    '--eof',
    '--max-args',
    '--max-chars',
    '--max-lines',
    '--max-procs',
    '--replace',
    '-E',
    '-I',
    '-J',
    '-L',
    '-P',
    '-R',
    '-S',
    '-a',
    '-d',
    '-n',
    '-s',
]);

const findHereDocuments = (line: string): HereDocument[] => {
    const documents: HereDocument[] = [];
    let quote: '"' | "'" | null = null;
    for (let index = 0; index < line.length - 1; index += 1) {
        const character = line[index];
        if (character === '\\' && quote !== "'") {
            index += 1;
            continue;
        }
        if (quote) {
            if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character !== '<' || line[index + 1] !== '<' || line[index + 2] === '<') continue;

        index += 2;
        const isStripTabs = line[index] === '-';
        if (isStripTabs) index += 1;
        while (/\s/u.test(line[index] ?? '')) index += 1;
        const delimiterQuote = line[index] === '"' || line[index] === "'" ? line[index] : null;
        if (delimiterQuote) index += 1;
        const start = index;
        while (
            index < line.length &&
            (delimiterQuote ? line[index] !== delimiterQuote : !/[;&|()<>\s]/u.test(line[index]))
        ) {
            index += 1;
        }
        const delimiter = line.slice(start, index);
        if (delimiter) documents.push({ delimiter, stripTabs: isStripTabs });
    }
    return documents;
};

/**
 * Remove here-document bodies because they are data, even when they contain command-like text.
 */
const withoutHereDocumentBodies = (command: string): string => {
    const pending: HereDocument[] = [];
    return command
        .split(/(?<=\n)/u)
        .map((line) => {
            if (pending.length > 0) {
                const document = pending[0];
                const content = line.replace(/\r?\n$/u, '');
                const candidate = document.stripTabs ? content.replace(/^\t+/u, '') : content;
                if (candidate === document.delimiter) pending.shift();
                return line.endsWith('\n') ? '\n' : '';
            }
            pending.push(...findHereDocuments(line));
            return line;
        })
        .join('');
};

/**
 * Split compound shell input without treating quoted arguments or later pipeline commands as part of one invocation.
 * This is intentionally a small lexer, not a shell evaluator.
 */
const shellCommandSegments = (command: string): ShellToken[][] => {
    const segments: ShellToken[][] = [];
    let tokens: ShellToken[] = [];
    let token = '';
    let quote: '"' | "'" | null = null;

    const finishToken = () => {
        if (token) tokens.push({ kind: 'word', value: token });
        token = '';
    };
    const finishSegment = () => {
        finishToken();
        if (tokens.length > 0) segments.push(tokens);
        tokens = [];
    };

    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        if (quote) {
            if (character === quote) quote = null;
            else if (character === '\\' && quote === '"' && index + 1 < command.length) {
                if (command[index + 1] !== '\n') token += command[index + 1];
                index += 1;
            } else token += character;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '\\' && index + 1 < command.length) {
            if (command[index + 1] !== '\n') token += command[index + 1];
            index += 1;
        } else if (character === '#' && token === '') {
            while (index < command.length && command[index] !== '\n') index += 1;
            finishSegment();
        } else if (/\s/u.test(character)) {
            finishToken();
            if (character === '\n' || character === '\r') finishSegment();
        } else if (
            character === '<' ||
            character === '>' ||
            (character === '&' && command[index + 1] === '>')
        ) {
            if (/^\d+$/u.test(token)) token = '';
            else finishToken();
            let redirect = character;
            if (character === '&') {
                redirect += command[index + 1];
                index += 1;
            } else {
                while (command[index + 1] === character || command[index + 1] === '&') {
                    redirect += command[index + 1];
                    index += 1;
                }
            }
            tokens.push({ kind: 'redirect', value: redirect });
        } else if (/[;&|()]/u.test(character)) {
            finishSegment();
        } else {
            token += character;
        }
    }
    finishSegment();
    return segments;
};

const isEnvironmentAssignment = (token: string): boolean => /^[A-Za-z_]\w*=/u.test(token);

export const executableBasename = (word: string | undefined): string =>
    word?.split('/').at(-1) ?? '';

export const withoutRedirections = (tokens: ShellToken[]): string[] => {
    const words: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].kind === 'redirect') {
            if (tokens[index + 1]?.kind === 'word') index += 1;
        } else {
            words.push(tokens[index].value);
        }
    }
    return words;
};

const wrappedExecutableIndexAfterOptions = (
    words: string[],
    startIndex: number,
    optionsWithValue: ReadonlySet<string>,
): number => {
    let executableIndex = startIndex;
    while (words[executableIndex]?.startsWith('-')) {
        const option = words[executableIndex];
        executableIndex += 1;
        if (option === '--') return executableIndex;
        if (!option.includes('=') && optionsWithValue.has(option)) executableIndex += 1;
    }
    return executableIndex;
};

const wrappedExecutableIndexAfterKnownOptions = (
    words: string[],
    startIndex: number,
    flags: ReadonlySet<string>,
    optionsWithValue: ReadonlySet<string>,
): number | null => {
    let executableIndex = startIndex;
    while (words[executableIndex]?.startsWith('-')) {
        const option = words[executableIndex];
        executableIndex += 1;
        if (option === '--') return executableIndex;
        const optionName = option.split('=', 1)[0];
        if (flags.has(optionName)) continue;
        if (!optionsWithValue.has(optionName)) return null;
        if (!option.includes('=')) executableIndex += 1;
    }
    return executableIndex;
};

const environmentWrappedExecutableIndex = (words: string[], startIndex: number): number | null => {
    let executableIndex = startIndex;
    while (
        isEnvironmentAssignment(words[executableIndex] ?? '') ||
        words[executableIndex]?.startsWith('-')
    ) {
        if (isEnvironmentAssignment(words[executableIndex] ?? '')) {
            executableIndex += 1;
            continue;
        }
        const option = words[executableIndex];
        executableIndex += 1;
        const optionName = option.split('=', 1)[0];
        if (optionName === '-S' || optionName === '--split-string') return null;
        if (option === '--') return executableIndex;
        if (!option.includes('=') && SHELL_OPTION_VALUE_NAMES.has(optionName)) executableIndex += 1;
    }
    return executableIndex;
};

/**
 * Unwrap shell constructs that execute the following argv directly. `env -S` is excluded here because it reparses a
 * command string and therefore must re-enter the lexer through `shellScriptFor`.
 */
export const commandExecutableIndex = (words: string[]): number | null => {
    let executableIndex = 0;
    while (true) {
        while (
            isEnvironmentAssignment(words[executableIndex] ?? '') ||
            SHELL_CONTROL_PREFIXES.has(words[executableIndex] ?? '')
        ) {
            executableIndex += 1;
        }
        const executable = executableBasename(words[executableIndex]);
        if (executable === 'env') {
            const wrappedIndex = environmentWrappedExecutableIndex(words, executableIndex + 1);
            if (wrappedIndex === null) return null;
            executableIndex = wrappedIndex;
            continue;
        }
        if (executable === 'time') {
            executableIndex = wrappedExecutableIndexAfterOptions(
                words,
                executableIndex + 1,
                TIME_OPTIONS_WITH_VALUE,
            );
            continue;
        }
        if (executable === 'command') {
            executableIndex += 1;
            while (words[executableIndex] === '-p') executableIndex += 1;
            if (words[executableIndex] === '--') executableIndex += 1;
            else if (words[executableIndex]?.startsWith('-')) return null;
            continue;
        }
        if (executable === 'exec') {
            executableIndex = wrappedExecutableIndexAfterOptions(
                words,
                executableIndex + 1,
                EXEC_OPTIONS_WITH_VALUE,
            );
            continue;
        }
        if (executable === 'nice') {
            if (['--help', '--version'].includes(words[executableIndex + 1] ?? '')) return null;
            executableIndex = wrappedExecutableIndexAfterOptions(
                words,
                executableIndex + 1,
                NICE_OPTIONS_WITH_VALUE,
            );
            continue;
        }
        if (executable === 'timeout' || executable === 'gtimeout') {
            if (['--help', '--version'].includes(words[executableIndex + 1] ?? '')) return null;
            executableIndex =
                wrappedExecutableIndexAfterOptions(
                    words,
                    executableIndex + 1,
                    TIMEOUT_OPTIONS_WITH_VALUE,
                ) + 1;
            continue;
        }
        if (executable === 'setsid') {
            const wrappedIndex = wrappedExecutableIndexAfterKnownOptions(
                words,
                executableIndex + 1,
                SETSID_EXECUTING_FLAGS,
                NO_OPTIONS_WITH_VALUE,
            );
            if (wrappedIndex === null) return null;
            executableIndex = wrappedIndex;
            continue;
        }
        if (executable === 'sudo') {
            const wrappedIndex = wrappedExecutableIndexAfterKnownOptions(
                words,
                executableIndex + 1,
                SUDO_EXECUTING_FLAGS,
                SUDO_OPTIONS_WITH_VALUE,
            );
            if (wrappedIndex === null) return null;
            executableIndex = wrappedIndex;
            continue;
        }
        if (SIMPLE_EXECUTION_WRAPPERS.has(executable)) {
            executableIndex += 1;
            if (words[executableIndex] === '--') executableIndex += 1;
            else if (words[executableIndex]?.startsWith('-')) return null;
            continue;
        }
        return words[executableIndex] ? executableIndex : null;
    }
};

/**
 * Extract commands reparsed by a shell-style wrapper so screenshot detection applies recursively without treating
 * ordinary argument text as executable input.
 */
const shellScriptFor = (tokens: ShellToken[]): string | null => {
    const words = withoutRedirections(tokens);

    if (executableBasename(words[0]) === 'coproc') {
        const commandIndex = words[2] === '{' ? 3 : words[1] === '{' ? 2 : 1;
        return words.slice(commandIndex).join(' ') || null;
    }

    let wrapperIndex = 0;
    while (
        isEnvironmentAssignment(words[wrapperIndex] ?? '') ||
        SHELL_CONTROL_PREFIXES.has(words[wrapperIndex] ?? '')
    ) {
        wrapperIndex += 1;
    }
    if (executableBasename(words[wrapperIndex]) === 'env') {
        for (let index = wrapperIndex + 1; index < words.length; index += 1) {
            const option = words[index];
            const optionName = option.split('=', 1)[0];
            if (optionName !== '-S' && optionName !== '--split-string') continue;
            const splitString = option.includes('=')
                ? option.slice(option.indexOf('=') + 1)
                : words[index + 1];
            const remainingIndex = index + (option.includes('=') ? 1 : 2);
            return splitString ? [splitString, ...words.slice(remainingIndex)].join(' ') : null;
        }
    }

    const executableIndex = commandExecutableIndex(words);
    if (executableIndex === null) return null;
    const executable = executableBasename(words[executableIndex]);
    if (['bash', 'dash', 'sh', 'zsh'].includes(executable)) {
        const commandOptionIndex = words.findIndex(
            (word, index) => index > executableIndex && /^-[^-]*c/u.test(word),
        );
        return commandOptionIndex !== -1 ? (words[commandOptionIndex + 1] ?? null) : null;
    }
    if (executable === 'eval') return words.slice(executableIndex + 1).join(' ') || null;
    if (executable === 'find') {
        const commands: string[] = [];
        for (let index = executableIndex + 1; index < words.length; index += 1) {
            if (words[index] !== '-exec' && words[index] !== '-execdir') continue;
            const endIndex = words.findIndex(
                (word, wordIndex) => wordIndex > index && (word === ';' || word === '+'),
            );
            commands.push(words.slice(index + 1, endIndex === -1 ? undefined : endIndex).join(' '));
            if (endIndex !== -1) index = endIndex;
        }
        return commands.filter(Boolean).join('; ') || null;
    }
    if (executable !== 'xargs') return null;

    let commandIndex = executableIndex + 1;
    while (words[commandIndex]?.startsWith('-')) {
        const option = words[commandIndex];
        commandIndex += 1;
        if (option === '--') break;
        const optionName = option.split('=', 1)[0];
        if (!option.includes('=') && XARGS_OPTIONS_WITH_VALUE.has(optionName)) commandIndex += 1;
    }
    return words.slice(commandIndex).join(' ') || null;
};

const matchingCommandSubstitutionEnd = (command: string, start: number): number => {
    let depth = 1;
    let quote: '"' | "'" | null = null;
    for (let index = start; index < command.length; index += 1) {
        const character = command[index];
        if (character === '\\' && quote !== "'") {
            index += 1;
            continue;
        }
        if (quote) {
            if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === '(') depth += 1;
        else if (character === ')' && --depth === 0) return index;
    }
    return -1;
};

const embeddedShellCommands = (command: string): string[] => {
    const embedded: string[] = [];
    let quote: '"' | "'" | null = null;
    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        if (character === '\\' && quote !== "'") {
            index += 1;
            continue;
        }
        if (character === "'") {
            if (quote === "'") quote = null;
            else quote ??= "'";
            continue;
        }
        if (character === '"') {
            if (quote === '"') quote = null;
            else quote ??= '"';
            continue;
        }
        if (quote === "'") continue;
        if (character === '$' && command[index + 1] === '(') {
            const end = matchingCommandSubstitutionEnd(command, index + 2);
            if (end >= 0) {
                embedded.push(command.slice(index + 2, end));
                index = end;
            }
        } else if (character === '`') {
            const end = command.indexOf('`', index + 1);
            if (end !== -1) {
                embedded.push(command.slice(index + 1, end));
                index = end;
            }
        }
    }
    return embedded;
};

/**
 * Every executable command segment, including commands nested in shell wrappers and command substitutions.
 */
export const executableSegments = (command: string, depth = 0): ShellToken[][] => {
    if (depth > 8) return [];
    const executableCommand = withoutHereDocumentBodies(command);
    const segments = shellCommandSegments(executableCommand);
    const nestedCommands = [
        ...segments.map(shellScriptFor).filter((script): script is string => script !== null),
        ...embeddedShellCommands(executableCommand),
    ];
    return [
        ...segments,
        ...nestedCommands.flatMap((nested) => executableSegments(nested, depth + 1)),
    ];
};
