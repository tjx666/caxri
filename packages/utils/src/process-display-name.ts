const INTERPRETERS = new Set(['bun', 'deno', 'node', 'perl', 'python', 'python3', 'ruby']);
const INTERPRETER_SUBCOMMANDS = new Set(['exec', 'run', 'x']);
/**
 * Flags whose value is inline source (`python -c '<code>'`, `node -e '<code>'`); the token after one is code, not a
 * script name, and may carry a credential.
 */
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '-p', '--command', '--eval', '--print']);
/**
 * A script name worth showing: a plain file name. Anything else (quotes, `?`, `=`) is an argument fragment.
 */
const SCRIPT_NAME = /^[\w.@+-]+$/;

function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Names a process after what it runs instead of where it lives: `/Users/me/.local/bin/claude --resume <id>` reads as
 * `claude`, and an interpreter reads as interpreter plus script (`node agent-launcher.js`, `bun watch-pr.ts`) because
 * the interpreter alone says nothing. Desktop's Process Explorer keeps the full command line beside it for hover; the
 * phone's computer status shows only this name, so no argument value ever leaves the Mac.
 *
 * Inline code (`-c`, `-e`) and anything that is not a plain file name fall back to the bare interpreter.
 *
 * Splitting on whitespace misreads an executable path that itself contains a space; the result is then a shorter but
 * still recognizable name.
 */
export function processDisplayName(command: string): string {
    const tokens = command.trim().split(/\s+/);
    // `ps` wraps a process that is exiting or has not exec'd yet in parentheses, e.g. `(git)`.
    const executable = basename(tokens[0].replace(/^\((.*)\)$/, '$1')).replace(/^-/, '');
    if (!INTERPRETERS.has(executable)) return executable || command;
    const options = tokens.slice(1);
    const scriptIndex = options.findIndex((token) => !token.startsWith('-'));
    if (
        options
            .slice(0, scriptIndex === -1 ? undefined : scriptIndex)
            .some((token) => INLINE_CODE_FLAGS.has(token))
    )
        return executable;
    const scriptArguments = options.filter((token) => !token.startsWith('-'));
    const script = INTERPRETER_SUBCOMMANDS.has(scriptArguments[0] ?? '')
        ? scriptArguments[1]
        : scriptArguments[0];
    const name = script && basename(script);
    return name && SCRIPT_NAME.test(name) ? `${executable} ${name}` : executable;
}
