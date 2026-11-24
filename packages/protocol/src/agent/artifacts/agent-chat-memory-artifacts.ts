import { pathBasename } from '@caxri/utils';

import type { AgentChatDiffLine } from '../agent-chat-diff.js';
import { agentChatDiffLines } from '../agent-chat-diff.js';
import type { AgentChatLabelTranslate } from '../agent-chat-labels.js';
import { translateAgentChatLabel } from '../agent-chat-labels.js';
import type { AgentChatEditedFile } from './agent-chat-turn-artifacts.js';

/**
 * The categories Claude Code's auto memory files declare in their frontmatter (`metadata.type`, or a top-level `type`
 * in older files).
 */
const AGENT_CHAT_MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

type AgentChatMemoryType = (typeof AGENT_CHAT_MEMORY_TYPES)[number];

/**
 * One memory file a finished turn saved, updated, or forgot, read from its diff rather than from disk.
 */
export interface AgentChatMemoryArtifact {
    path: string;
    action: 'created' | 'updated' | 'deleted';
    /**
     * The frontmatter `name`, else the file name without `.md`.
     */
    name: string;
    /**
     * The frontmatter `description`: the one line that says what the memory is about.
     */
    description?: string;
    type?: AgentChatMemoryType;
    /**
     * The Markdown after the frontmatter, known only for a memory the turn created, whose diff carries the whole file.
     * An update's diff holds just the changed hunks, so its card shows the diff instead.
     */
    body?: string;
    /**
     * The merged change behind the card, for the diff an update shows and the `+N -M` it counts.
     */
    file: AgentChatEditedFile;
}

/**
 * `~/.claude/projects/<project>/memory/<file>.md`, under any hidden config directory, so a `CLAUDE_CONFIG_DIR` such as
 * `~/.claude-work` matches as well. Requiring the hidden segment keeps a repository's own `projects/x/memory/` notes
 * out.
 */
const MEMORY_FILE = /[/\\]\.[^/\\]+[/\\]projects[/\\][^/\\]+[/\\]memory[/\\]([^/\\]+\.md)$/u;

/**
 * The index Claude Code loads every session; it points at the memory files rather than being one.
 */
const MEMORY_INDEX = 'MEMORY.md';

function memoryFileName(path: string): string | undefined {
    return MEMORY_FILE.exec(path)?.[1];
}

export function isAgentChatMemoryPath(path: string): boolean {
    const name = memoryFileName(path);
    return name !== undefined && name !== MEMORY_INDEX;
}

export function isAgentChatMemoryIndexPath(path: string): boolean {
    return memoryFileName(path) === MEMORY_INDEX;
}

interface MemoryFrontmatter {
    fields: Map<string, string>;
    body: string;
}

function unquote(value: string): string {
    const trimmed = value.trim();
    const quote = trimmed.at(0);
    if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote && trimmed.length >= 2)
        return trimmed.slice(1, -1);
    return trimmed;
}

/**
 * A memory file's `---` frontmatter as flat `key: value` pairs. Nested keys (`metadata:` then ` type: feedback`) are
 * read by their own name, which is all a memory file uses; anything richer than scalars is ignored.
 */
function parseFrontmatter(lines: readonly string[]): MemoryFrontmatter | undefined {
    if (lines[0]?.trim() !== '---') return undefined;
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end === -1) return undefined;
    const fields = new Map<string, string>();
    for (const line of lines.slice(1, end)) {
        const match = /^\s*([\w-]+):(.*)$/u.exec(line);
        const key = match?.[1];
        const value = match?.[2] === undefined ? '' : unquote(match[2]);
        if (value && key && !fields.has(key)) fields.set(key, value);
    }
    return {
        fields,
        body: lines
            .slice(end + 1)
            .join('\n')
            .trim(),
    };
}

function memoryType(value: string | undefined): AgentChatMemoryType | undefined {
    return AGENT_CHAT_MEMORY_TYPES.find((type) => type === value);
}

/**
 * The text the diff shows of the file: after the turn for a create or update, before it for a delete.
 */
function visibleText(lines: readonly AgentChatDiffLine[], kind: AgentChatEditedFile['kind']) {
    const keep: ReadonlySet<AgentChatDiffLine['kind']> =
        kind === 'delete' ? new Set(['removed', 'context']) : new Set(['added', 'context']);
    return lines.filter((line) => keep.has(line.kind)).map((line) => line.text);
}

/**
 * The card a memory file's merged change becomes. Fields the diff does not show (an update that left the frontmatter
 * alone) fall back to the file name.
 */
export function agentChatMemoryArtifact(file: AgentChatEditedFile): AgentChatMemoryArtifact {
    const frontmatter = parseFrontmatter(
        visibleText(
            file.changes.flatMap((change) => agentChatDiffLines(change)),
            file.kind,
        ),
    );
    const name = frontmatter?.fields.get('name') ?? pathBasename(file.path).replace(/\.md$/iu, '');
    const description = frontmatter?.fields.get('description');
    const type = memoryType(frontmatter?.fields.get('type'));
    const action = file.kind === 'add' ? 'created' : file.kind === 'delete' ? 'deleted' : 'updated';
    const body =
        action === 'created' && !file.truncated && frontmatter?.body ? frontmatter.body : undefined;
    return {
        path: file.path,
        action,
        name,
        file,
        ...(description && { description }),
        ...(type && { type }),
        ...(body && { body }),
    };
}

const ACTION_LABEL = {
    created: 'agentChat.memory.created',
    updated: 'agentChat.memory.updated',
    deleted: 'agentChat.memory.deleted',
} as const;

const TYPE_LABEL = {
    user: 'agentChat.memory.type.user',
    feedback: 'agentChat.memory.type.feedback',
    project: 'agentChat.memory.type.project',
    reference: 'agentChat.memory.type.reference',
} as const satisfies Record<AgentChatMemoryType, string>;

/**
 * `Saved memory`, `Updated memory`, `Forgot memory`.
 */
export function agentChatMemoryActionLabel(
    memory: Pick<AgentChatMemoryArtifact, 'action'>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    return t(ACTION_LABEL[memory.action]);
}

/**
 * `Feedback`, `Project`: the memory's category, or `undefined` when the file declares none the card knows.
 */
export function agentChatMemoryTypeLabel(
    memory: Pick<AgentChatMemoryArtifact, 'type'>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string | undefined {
    return memory.type ? t(TYPE_LABEL[memory.type]) : undefined;
}
