import { inlineHeredocs } from '../agent-shell-command.js';

/**
 * Codex reports every command as the login-shell invocation that ran it (`/bin/zsh -lc "git status"`). The wrapper is
 * the same on every row, so only the inner command is worth reading. Anything that is not exactly one quoted script
 * passed to `sh`, `bash`, or `zsh` is returned unchanged.
 */
export const unwrapShellCommand = (command: string): string => {
    const match = /^(?:\S*\/)?(?:ba|z)?sh -l?c (["'])([\s\S]*)\1$/u.exec(command.trim());
    if (!match) return command;
    const [, quote, script = ''] = match;
    return quote === '"'
        ? script.replaceAll(String.raw`\"`, '"').replaceAll(String.raw`\\`, '\\')
        : script;
};

/**
 * Plumbing an Agent appends only to keep its own output short (`2>&1`, `2>/dev/null`, a trailing `| head -30`) says
 * nothing about what the command does, yet fills a one-line title. The title drops it at each command boundary; the
 * expanded row keeps the exact command line.
 */
const SHELL_TITLE_NOISE =
    /\s*(?:\d?>&\d|&?\d?>\s*\/dev\/null|\|\s*(?:head|tail)(?:\s+-n)?(?:\s+-?\d+)?)(?=\s*(?:;|&&|\|\||$))/gu;

/**
 * One shell word, quotes and escapes included (`"agent-browser --session $S"`, `Application\ Support`), never crossing
 * an unquoted `;`, `&`, or `|`.
 */
const SHELL_WORD = String.raw`(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s;&|'"\\])+`;

/**
 * A statement that only prepares the command after it, ending in `&&`, `;`, or a newline: `cd <dir>`, variable
 * assignments (`S=acc; A="agent-browser --session $S"`), `export`, a fixed `sleep`, or sourcing a helper (`. lib.sh`).
 * Measured on local Claude Code and Codex transcripts, a leading `cd` alone opened about two thirds of the commands the
 * Agent left undescribed, so the title otherwise reads as the same worktree path on every row.
 */
const SHELL_VALUE = SHELL_WORD.replace(/\+$/u, '*');
const SHELL_ASSIGNMENTS = String.raw`[A-Za-z_]\w*=${SHELL_VALUE}(?:\s+[A-Za-z_]\w*=${SHELL_VALUE})*`;
const SHELL_TITLE_SETUP = new RegExp(
    String.raw`^\s*(?:cd\s+${SHELL_WORD}|(?:export\s+)?${SHELL_ASSIGNMENTS}|sleep\s+\d+(?:\.\d+)?|(?:\.|source)\s+${SHELL_WORD})[ \t]*(?:&&|;|\n)\s*`,
    'u',
);

const SHELL_ASSIGNMENT = new RegExp(String.raw`([A-Za-z_]\w*)=(${SHELL_WORD})?`, 'gu');

function unquoteShellWord(word: string): string {
    return /^(['"])[\s\S]*\1$/u.test(word) ? word.slice(1, -1) : word;
}

/**
 * An Agent driving a CLI repeatedly names it once (`A="agent-browser --session $S"; $A click @e25`). With the
 * assignment dropped from the title, a command that starts with that variable reads as its value again; a variable used
 * as an argument (`--session $S`) stays as written, since its value is usually an opaque identifier.
 */
function withCommandVariablesExpanded(
    command: string,
    variables: ReadonlyMap<string, string>,
): string {
    if (variables.size === 0) return command;
    return command.replaceAll(
        /(^|&&|[;\n|])(\s*)\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))(?![\w{])/gu,
        (whole, separator: string, space: string, braced?: string, bare?: string) => {
            const value = variables.get(braced ?? bare ?? '');
            return value ? `${separator}${space}${value}` : whole;
        },
    );
}

/**
 * A heredoc's opener (`<<'EOF'`, `<<-PY`), whose body is script or file contents rather than what the command does.
 */
const HEREDOC_OPENER = /<<-?\s*(['"]?)(\w+)\1/u;

/**
 * Drops every heredoc body, keeping the line that opens it (`python3 - <<'EOF'`, `cat > notes.md <<'EOF'`), so a title
 * names the command instead of the first lines of the script it feeds. An unterminated heredoc is left unchanged.
 */
function withoutHeredocBodies(command: string): string {
    const lines = command.split('\n');
    const kept: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        kept.push(line);
        const tag = HEREDOC_OPENER.exec(line)?.[2];
        if (!tag) continue;
        const end = lines.findIndex((candidate, at) => at > index && candidate.trim() === tag);
        if (end === -1) return command;
        index = end;
    }
    return kept.join('\n');
}

/**
 * The one-line title of a command no action describes. The expanded row still shows the exact command line.
 */
export const readableShellCommand = (command: string): string => {
    let readable = withoutHeredocBodies(inlineHeredocs(command.trim()));
    const variables = new Map<string, string>();
    // Setup is only stripped while a command still follows it, so `cd src` alone keeps its title.
    for (
        let match = SHELL_TITLE_SETUP.exec(readable);
        match;
        match = SHELL_TITLE_SETUP.exec(readable)
    ) {
        const rest = readable.slice(match[0].length);
        if (rest.trim() === '') break;
        const statement = match[0];
        if (!/^\s*(?:cd|sleep|\.|source)\s/u.test(statement)) {
            const assignments = statement.matchAll(SHELL_ASSIGNMENT);
            for (const [, name = '', value = ''] of assignments)
                variables.set(name, unquoteShellWord(value));
        }
        readable = rest;
    }
    readable = withCommandVariablesExpanded(readable, variables);
    // Stripping `| tail -1` leaves the `2>&1` before it at the end of its command, so repeat until nothing changes.
    for (let previous = ''; previous !== readable;) {
        previous = readable;
        readable = readable.replaceAll(SHELL_TITLE_NOISE, '');
    }
    return readable.trim() || command;
};
