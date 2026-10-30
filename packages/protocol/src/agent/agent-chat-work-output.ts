import type { AgentChatWorkItem } from './agent-chat-work.js';
import type { AgentToolKind } from './agent-tool-presentation.js';
import { describeAgentTool, unwrapShellCommand } from './agent-tool-presentation.js';

/**
 * The last path-like token's extension, such as `md` in `sed -n '1,40p' docs/SKILL.md`.
 */
function trailingFileExtension(text: string): string | undefined {
    const matches = Array.from(
        text.matchAll(/[\w@~./-]*\w\.([A-Za-z][\w-]{0,9})(?=$|[\s'"`;|&)])/gu),
    );
    return matches.at(-1)?.[1]?.toLowerCase();
}

function isJsonText(text: string): boolean {
    const trimmed = text.trim();
    if (!/^[[{]/u.test(trimmed)) return false;
    try {
        JSON.parse(trimmed);
        return true;
    } catch {
        return false;
    }
}

const FILE_TOOL_KINDS: ReadonlySet<AgentToolKind> = new Set(['read', 'write', 'edit']);

/**
 * Commands whose output is the content of the file they name, so the file's extension is the output's language.
 */
const FILE_PRINTING_COMMAND = /^\s*(?:cat|sed|head|tail|nl|bat|less|more)\s/u;

/**
 * The language to paint a command's or tool's output with, inferred from what produced it: a Git diff, a printed or
 * read file's extension, or JSON. Any other command output is painted as shell, the terminal it came from, so its
 * strings, numbers, flags, and paths still separate from the prose around them; another tool's output stays plain.
 */
export function agentChatOutputLanguage(
    item: Extract<AgentChatWorkItem, { type: 'command' | 'toolCall' }>,
): string | undefined {
    const output = item.output ?? '';
    if (item.type === 'command') {
        const command = unwrapShellCommand(item.command);
        // Only the last pipeline stage and chained command decide what was printed.
        const lastStage = command.split(/\|\||&&|;|\|/u).at(-1) ?? command;
        if (
            /\bgit\s(?:.*\s)?(?:diff|show)\b/u.test(lastStage) &&
            !/--(?:stat|name-only|name-status|oneline)\b/u.test(lastStage)
        )
            return 'diff';
        if (FILE_PRINTING_COMMAND.test(lastStage)) {
            const extension = trailingFileExtension(lastStage);
            if (extension) return extension;
        }
    } else {
        const { kind } = describeAgentTool(item);
        if (FILE_TOOL_KINDS.has(kind) && item.summary) {
            const extension = trailingFileExtension(item.summary);
            if (extension) return extension;
        }
    }
    if (isJsonText(output)) return 'json';
    return item.type === 'command' ? 'shell' : undefined;
}

/**
 * Lays out JSON output one member per line with two-space indentation, the way the Codex app and browser devtools show
 * a `--json` result instead of one wrapped run-on line. Only whitespace between tokens changes: the text is re-indented
 * rather than parsed and re-serialized, so a number beyond `Number.MAX_SAFE_INTEGER` (a Snowflake ID) or a duplicated
 * key keeps its exact source. Any text that is not complete JSON, such as a truncated or still-streaming output, is
 * returned unchanged.
 */
export function formatAgentChatJsonOutput(text: string): string {
    if (!isJsonText(text)) return text;
    const source = text.trim();
    let result = '';
    let depth = 0;
    const newline = () => `\n${'  '.repeat(depth)}`;
    /**
     * Appends the token at `index` and returns the index of its last character.
     */
    const layOut = (index: number): number => {
        const char = source[index];
        switch (char) {
            case '"': {
                let end = index + 1;
                while (source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
                result += source.slice(index, end + 1);
                return end;
            }
            case '{':
            case '[': {
                let next = index + 1;
                while (/\s/u.test(source[next] ?? '')) next += 1;
                if (source[next] === (char === '{' ? '}' : ']')) {
                    result += char + source[next];
                    return next;
                }
                depth += 1;
                result += char + newline();
                return index;
            }
            case '}':
            case ']': {
                depth -= 1;
                result += newline() + char;
                return index;
            }
            case ',': {
                result += char + newline();
                return index;
            }
            case ':': {
                result += ': ';
                return index;
            }
            default: {
                if (!/\s/u.test(char)) result += char;
                return index;
            }
        }
    };
    for (let index = 0; index < source.length; index = layOut(index) + 1);
    return result;
}

/**
 * Claude Code's Read result numbers every line (` 12→const a = 1`). The numbers are not part of the file and would
 * break its highlighting, so they are dropped when every non-empty line carries one.
 */
export function stripLineNumberGutter(text: string): string {
    const lines = text.split('\n');
    const gutter = /^\s*\d+(?:→|\t)/u;
    if (
        lines.every((line) => line === '') ||
        lines.some((line) => !(line === '' || gutter.test(line)))
    )
        return text;
    return lines.map((line) => line.replace(gutter, '')).join('\n');
}

/**
 * The arguments an expanded tool row shows: the JSON preview when the row title (`summary`) is only a readable digest
 * of them, else the summary itself, which then is the arguments preview.
 */
export function agentChatToolCallArguments(
    item: Pick<Extract<AgentChatWorkItem, { type: 'toolCall' }>, 'input' | 'summary'>,
): string | undefined {
    return item.input ?? item.summary;
}
