import type { AgentChatLabelKey } from '../../agent-chat-labels.js';
import { withoutShellSetup } from './agent-shell-title.js';

/**
 * The label of a row for a script an Agent wrote inline, by the language that runs it.
 */
export type AgentShellScriptLabel =
    | 'Ran Bun script'
    | 'Ran Node.js script'
    | 'Ran Perl script'
    | 'Ran Python script'
    | 'Ran Ruby script'
    | 'Ran shell script';

/**
 * The catalog noun of each script label (`Python script`), which the `ranScript`, `active.script`, `verb.script`, and
 * `stopped.script` phrases embed, so a script row reads in the reader's language in every state.
 */
export const SCRIPT_LABEL_NOUNS: Readonly<Record<AgentShellScriptLabel, AgentChatLabelKey>> = {
    'Ran Bun script': 'agentChat.tool.script.bun',
    'Ran Node.js script': 'agentChat.tool.script.node',
    'Ran Perl script': 'agentChat.tool.script.perl',
    'Ran Python script': 'agentChat.tool.script.python',
    'Ran Ruby script': 'agentChat.tool.script.ruby',
    'Ran shell script': 'agentChat.tool.script.shell',
};

export const isAgentShellScriptLabel = (label: string): label is AgentShellScriptLabel =>
    Object.hasOwn(SCRIPT_LABEL_NOUNS, label);

/**
 * Command labels whose subject the Agent's own description of the command replaces: a plain `Ran`, a GitHub API call
 * that names only its endpoint, and an inline script that names only its language.
 */
export const isDescribedCommandLabel = (label: string): boolean =>
    label === 'Ran' || label === 'Called GitHub API' || isAgentShellScriptLabel(label);

/**
 * What the first statement of a command does when it is a script the Agent wrote inline (`python3 - <<'EOF'`, `node -e
 * '...'`) or a file it writes from a heredoc (`cat > notes.md <<'EOF'`). `rest` is whatever follows that statement;
 * `note` is the comment that opens a script, when it has one.
 */
export type AgentShellScriptStep =
    | { kind: 'script'; label: AgentShellScriptLabel; note?: string; rest?: string }
    | { kind: 'write'; path: string; rest?: string };

const INTERPRETER_LABELS: Readonly<Partial<Record<string, AgentShellScriptLabel>>> = {
    bash: 'Ran shell script',
    bun: 'Ran Bun script',
    node: 'Ran Node.js script',
    perl: 'Ran Perl script',
    python: 'Ran Python script',
    ruby: 'Ran Ruby script',
    sh: 'Ran shell script',
    zsh: 'Ran shell script',
};

/**
 * An interpreter, optionally by path or behind `uv run` and its options: `python3`, `/usr/bin/python3.12`, `uv run
 * --with rich python`.
 */
const INTERPRETER = String.raw`(?:uv\s+run\s+(?:-[\w-]+(?:[= ][^\s;&|<>-]\S*)?\s+)*)?(?:\S*\/)?(?<name>python|python3(?:\.\d+)?|node|bun|ruby|perl|bash|sh|zsh)`;

/**
 * One argument word that cannot start a redirection or end the statement (`-I`, `-`, `"$f"`).
 */
const ARGUMENT = String.raw`(?:'[^']*'|"[^"]*"|[^\s;&|<>'"]+)`;

/**
 * A heredoc opener and the rest of its line, which starts at a non-word character so it cannot extend the tag.
 */
const HEREDOC = String.raw`<<-?\s*(?<quote>['"]?)(?<tag>\w+)\k<quote>(?<after>(?:[^\w\n][^\n]*)?)\n`;

const SCRIPT_HEREDOC = new RegExp(String.raw`^${INTERPRETER}(?:\s+${ARGUMENT})*\s*${HEREDOC}`, 'u');

/**
 * A script passed as one quoted argument: `python3 -c '...'`, `node -e "..."`, `perl -pi -e 's/a/b/' file`. A shell's
 * `-c` only wraps another command, so `bash -c` is not a script here.
 */
const SCRIPT_INLINE = new RegExp(
    String.raw`^${INTERPRETER}(?:\s+-[\w-]+)*\s+-[ce]\s+(?:'[^']*'|"(?:[^"\\]|\\.)*")`,
    'u',
);

const WRITE_PATH = String.raw`(?<path>'[^']*'|"[^"]*"|[^\s;&|<>'"]+)`;

/**
 * A heredoc written to a file: `cat > notes.md <<'EOF'`, `cat <<EOF >> log.md`, `tee -a notes.md <<EOF >/dev/null`.
 */
const WRITE_HEREDOCS = [
    new RegExp(String.raw`^cat\s*>>?\s*${WRITE_PATH}\s*${HEREDOC}`, 'u'),
    new RegExp(
        String.raw`^cat\s*<<-?\s*(?<quote>['"]?)(?<tag>\w+)\k<quote>\s*>>?\s*${WRITE_PATH}(?<after>(?:[\s;&|<>][^\n]*)?)\n`,
        'u',
    ),
    new RegExp(String.raw`^tee\s+(?:-a\s+)?${WRITE_PATH}(?:\s*>\s*\/dev\/null)?\s*${HEREDOC}`, 'u'),
];

/**
 * The text after a statement, without the `&&`, `;`, or newline that separates it, or `undefined` when nothing follows.
 * An `echo` that only marks progress (`echo done`, `echo ---`) is not worth a title either.
 */
function restAfter(text: string): string | undefined {
    const rest = text
        .replace(/^\s*(?:&&|;)?\s*/u, '')
        .replace(/^(?:echo\s+(?:[^\s$&;<>`|][^|<>$`;&\n]*)?(?:&&|;|\n)\s*)+/u, '')
        .trim();
    if (rest === '') return undefined;
    const isOnlyEchoes = rest
        .split(/&&|;|\n/u)
        .every((statement) => /^\s*(?:echo\s[^|<>$`]*)?$/u.test(statement));
    return isOnlyEchoes ? undefined : rest;
}

/**
 * A heredoc's body and what follows its terminator line, with anything after the opener that chains another command
 * (`<<'EOF' && echo ok`) kept in front of it. A pipe or redirection after the opener only shapes the output and is
 * dropped. An unterminated heredoc yields `undefined`.
 */
function heredocParts(
    text: string,
    match: RegExpExecArray,
): { body: string[]; rest?: string } | undefined {
    const { tag = '', after = '' } = match.groups ?? {};
    const lines = text.slice(match[0].length).split('\n');
    const end = lines.findIndex((line) => line.trim() === tag);
    if (end === -1) return undefined;
    const chained = /^\s*(?:&&|;)/u.test(after) ? `${after}\n` : '';
    const rest = restAfter(`${chained}${lines.slice(end + 1).join('\n')}`);
    return { body: lines.slice(0, end), ...(rest !== undefined && { rest }) };
}

/**
 * The comment a script opens with (`# Count the rows per Session`), which says what it does better than its language.
 */
function scriptNote(body: readonly string[]): string | undefined {
    const first = body.find((line) => line.trim() !== '')?.trim() ?? '';
    const note = /^(?:#(?!!)|\/\/)\s*(?<text>\S.*)$/u.exec(first)?.groups?.text.trim();
    return note === undefined || note === '' ? undefined : note;
}

const unquoted = (word: string): string =>
    /^(['"])[\s\S]*\1$/u.test(word) ? word.slice(1, -1) : word;

/**
 * Reads the first real statement of a command (after setup such as `cd`) as an inline script or a heredoc file write.
 * Anything else, including a script file run by path (`python3 tool.py`), returns `null`.
 */
export function describeShellScript(command: string): AgentShellScriptStep | null {
    const text = withoutShellSetup(command);
    const heredoc = SCRIPT_HEREDOC.exec(text);
    if (heredoc) {
        const label = INTERPRETER_LABELS[(heredoc.groups?.name ?? '').replace(/3(?:\.\d+)?$/u, '')];
        const parts = label && heredocParts(text, heredoc);
        if (!label || !parts) return null;
        const note = scriptNote(parts.body);
        return {
            kind: 'script',
            label,
            ...(note !== undefined && { note }),
            ...(parts.rest !== undefined && { rest: parts.rest }),
        };
    }
    const inline = SCRIPT_INLINE.exec(text);
    const inlineName = inline?.groups?.name ?? '';
    if (inline && !['bash', 'sh', 'zsh'].includes(inlineName)) {
        const label = INTERPRETER_LABELS[inlineName.replace(/3(?:\.\d+)?$/u, '')];
        if (!label) return null;
        // Arguments, pipes, and redirections after the script stay part of its statement.
        const separator = /^[^'"\n;&]*(?:&&|;|\n)/u.exec(text.slice(inline[0].length));
        const rest = separator && restAfter(text.slice(inline[0].length + separator[0].length));
        return { kind: 'script', label, ...(rest && { rest }) };
    }
    for (const pattern of WRITE_HEREDOCS) {
        const write = pattern.exec(text);
        const parts = write && heredocParts(text, write);
        if (!write || !parts) continue;
        const path = unquoted(write.groups?.path ?? '');
        return { kind: 'write', path, ...(parts.rest !== undefined && { rest: parts.rest }) };
    }
    return null;
}
