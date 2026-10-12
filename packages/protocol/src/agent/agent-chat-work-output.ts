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
