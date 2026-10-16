import type {
    AgentChatItem,
    AgentChatModel,
    AgentChatPatchOperation,
    AgentChatResponse,
    AgentChatSnapshot,
    AgentChatTurn,
} from '@caxri/protocol';
import { agentChatModelSchema, CaxriError, MAX_AGENT_CHAT_MODELS } from '@caxri/protocol';

/**
 * Provider-neutral helpers every Chat provider uses to build projection operations. Provider inputs are untrusted JSON,
 * so readers are defensive and every string is bounded.
 */

type Json = Record<string, unknown>;

/**
 * Turns a projection keeps; older ones are dropped while their items stay until the item budget evicts them.
 */
export const MAX_TRACKED_TURNS = 200;

export function isRecord(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

export function clip(value: string, limit: number): string {
    return value.length <= limit ? value : value.slice(0, limit);
}

/**
 * Input fields a person would name an unmapped tool's call by, in precedence order.
 */
const READABLE_INPUT_FIELDS = [
    'description',
    'summary',
    'title',
    'name',
    'message',
    'query',
    'path',
    'file_path',
    'url',
    'command',
] as const;

function firstLine(value: string): string {
    return value.trim().split('\n', 1)[0]?.trim() ?? '';
}

/**
 * A one-line summary of a tool input no provider table maps: the first line of a field that names the call, else `key:
 * value` for the first scalar field, else nothing. A raw JSON dump (`SendMessage {"to":"a9a7…`) is what a row title
 * must never show.
 */
export function readableToolInputSummary(input: Json, limit: number): string | undefined {
    for (const key of READABLE_INPUT_FIELDS) {
        const value = input[key];
        const line = typeof value === 'string' ? firstLine(value) : '';
        if (line) return clip(line, limit);
    }
    for (const [key, value] of Object.entries(input)) {
        const scalar =
            typeof value === 'string'
                ? firstLine(value)
                : typeof value === 'number' || typeof value === 'boolean'
                  ? String(value)
                  : '';
        if (scalar) return clip(`${key}: ${scalar}`, limit);
    }
    return undefined;
}

export function tail(value: string, limit: number): string {
    return value.length <= limit ? value : value.slice(value.length - limit);
}

function prefixedLines(value: string, prefix: '+' | '-'): string[] {
    if (!value) return [];
    return value
        .replace(/\n$/u, '')
        .split('\n')
        .map((line) => `${prefix}${line}`);
}

/**
 * A unified-diff-style body for one replacement, for a provider that reports an edit as old and new text rather than a
 * patch with line numbers. An empty `oldText` reads as a whole-file write.
 */
export function replacementDiff(oldText: string, newText: string): string {
    return ['@@', ...prefixedLines(oldText, '-'), ...prefixedLines(newText, '+')].join('\n');
}

/**
 * Closes an item the provider left open when its turn ended.
 */
export function closeDanglingItem(item: AgentChatItem): AgentChatItem | undefined {
    switch (item.type) {
        case 'agentMessage':
        case 'reasoning': {
            return item.streaming ? { ...item, streaming: false } : undefined;
        }
        case 'command':
        case 'fileChange':
        case 'toolCall': {
            return item.status === 'running' ? { ...item, status: 'interrupted' } : undefined;
        }
        default: {
            return undefined;
        }
    }
}

/**
 * Operations for a provider process that ended: open items close as interrupted, the running turn is interrupted, a
 * compaction stops, and every pending request goes away with the process that asked it.
 */
export function endedSessionOperations(
    snapshot: AgentChatSnapshot,
    interruptionReason?: AgentChatTurn['interruptionReason'],
): AgentChatPatchOperation[] {
    const operations: AgentChatPatchOperation[] = [];
    for (const item of snapshot.items) {
        const closed = closeDanglingItem(item);
        if (closed) operations.push({ op: 'upsertItem', item: closed });
    }
    const { activeTurnId } = snapshot;
    operations.push({
        op: 'state',
        state: {
            requests: [],
            activeTurnId: null,
            // A process that died mid-compaction never reports its end; a stale flag would hold the queue forever.
            ...(snapshot.operation === 'compacting' && { operation: null }),
            ...(activeTurnId && {
                turns: snapshot.turns.map((turn) =>
                    turn.id === activeTurnId
                        ? {
                              ...turn,
                              status: 'interrupted' as const,
                              ...(interruptionReason && { interruptionReason }),
                          }
                        : turn,
                ),
            }),
        },
    });
    return operations;
}

/**
 * Answers for a question request. Skipping is a `cancel` decision from the Client; an empty `answers` map is the
 * provider-neutral "no answer", so the turn continues instead of blocking on the user.
 */
export function questionAnswers(response: AgentChatResponse): Record<string, string[]> {
    if (response.kind === 'answers') return response.answers;
    if (response.decision === 'cancel') return {};
    throw new CaxriError('VALIDATION', 'A question needs answers');
}

/**
 * The prompt text that runs a slash command, for a provider that expands a command typed as a message (Claude Code and
 * Grok Build) exactly as its own terminal UI would.
 */
export function slashCommandPrompt(name: string, arguments_: string | undefined): string {
    return arguments_ ? `/${name} ${arguments_}` : `/${name}`;
}

/**
 * Whether the running provider offers `name`, so a stale Client cannot reach a method the provider never listed.
 */
export function isAgentChatCommandListed(snapshot: AgentChatSnapshot, name: string): boolean {
    return snapshot.commands?.some((command) => command.name === name) ?? false;
}

/**
 * Bounds a provider-listed model to the projection's limits, or drops it when what remains is still invalid (an effort
 * name with unexpected characters, a missing identifier), so one odd entry cannot fail the whole snapshot.
 */
export function boundedChatModels(models: readonly AgentChatModel[]): AgentChatModel[] {
    const bounded: AgentChatModel[] = [];
    for (const model of models) {
        const parsed = agentChatModelSchema.safeParse({
            ...model,
            id: clip(model.id, 200),
            displayName: clip(model.displayName, 200),
            ...(model.description && { description: clip(model.description, 500) }),
            ...(model.resolvedId && { resolvedId: clip(model.resolvedId, 200) }),
            efforts: model.efforts.slice(0, 10),
        });
        if (parsed.success) bounded.push(parsed.data);
        if (bounded.length === MAX_AGENT_CHAT_MODELS) break;
    }
    return bounded;
}
