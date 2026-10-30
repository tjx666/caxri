import type {
    AgentChatItem,
    AgentChatSnapshot,
    AgentProvider,
    AgentUsageLimitWindow,
} from '@caxri/protocol';
import { agentProviderCatalog, parseDelegatedTaskPointer } from '@caxri/protocol';

/**
 * The delegation prompt limit (`agentDelegationCreateRequestSchema`), in UTF-8 bytes, less room for its frozen
 * instructions header.
 */
const MAX_BRIEF_BYTES = 15_000;

/**
 * Each earlier conversation entry is cut to this many characters, as T3 Code's portable hand-offs do; the last request
 * and a generated hand-off keep more, since the next Agent acts on them.
 */
const ENTRY_CHARACTERS = 240;
const LAST_REQUEST_CHARACTERS = 2_000;
const DOCUMENT_CHARACTERS = 8_000;
const MAX_CHANGED_FILES = 40;

export interface ContinuationBriefInput {
    snapshot: Pick<AgentChatSnapshot, 'items' | 'plan'>;
    source: AgentProvider;
    /**
     * Why the work moves: the used-up window of a failed turn, the weekly guard, or the user choosing another Agent.
     */
    reason:
        | { kind: 'usageLimit'; window: AgentUsageLimitWindow }
        | { kind: 'usageGuard' }
        | { kind: 'manual' };
    /**
     * A hand-off the source model wrote on the guard's reserved budget, when there is one.
     */
    document?: string;
}

function oneLine(text: string, characters: number): string {
    const flat = text.replaceAll(/\s+/gu, ' ').trim();
    return flat.length > characters ? `${flat.slice(0, characters - 1)}…` : flat;
}

function block(text: string, characters: number): string {
    const trimmed = text.trim();
    return trimmed.length > characters ? `${trimmed.slice(0, characters - 1)}…` : trimmed;
}

/**
 * A delegated task pointer reaches the provider as plain user text; the next Agent cannot read it, so it is named for
 * what it is instead.
 */
function userText(item: Extract<AgentChatItem, { type: 'userMessage' }>): string {
    return parseDelegatedTaskPointer(item.text)
        ? (item.delegatedTask?.prompt ?? 'A delegated task')
        : item.text;
}

function entry(item: AgentChatItem, source: string): string | undefined {
    switch (item.type) {
        case 'userMessage': {
            return `- User: ${oneLine(userText(item), ENTRY_CHARACTERS)}`;
        }
        case 'agentMessage': {
            return item.text.trim()
                ? `- ${source}: ${oneLine(item.text, ENTRY_CHARACTERS)}`
                : undefined;
        }
        case 'command': {
            const exit = item.exitCode === undefined ? item.status : `exit ${item.exitCode}`;
            return `- Ran \`${oneLine(item.command, ENTRY_CHARACTERS)}\` (${exit})`;
        }
        case 'fileChange': {
            const paths = item.changes.map((change) => `${change.path} (${change.kind})`);
            return paths.length > 0
                ? `- Changed ${oneLine(paths.join(', '), ENTRY_CHARACTERS)}`
                : undefined;
        }
        default: {
            // Reasoning, tool calls, and notices are the source's working state, not the work.
            return undefined;
        }
    }
}

function windowName(window: AgentUsageLimitWindow): string {
    if (window === 'session') return '5-hour usage limit';
    if (window === 'weekly') return 'weekly usage limit';
    return 'usage limit';
}

const encoder = new TextEncoder();

function bytes(text: string): number {
    return encoder.encode(text).length;
}

/**
 * The deterministic context package another Agent continues from: what the user asked last, the open plan, every file
 * changed, and as much of the recent conversation as fits, newest kept first. Built from the Chat's own projection,
 * never by asking the source provider, so it works after the source's usage is gone. Adapted from T3 Code's portable
 * context hand-offs. Private user content: never logged.
 */
export function buildContinuationBrief(input: ContinuationBriefInput): string {
    const { snapshot, source, reason, document } = input;
    const sourceName = agentProviderCatalog[source].displayName;
    const why =
        reason.kind === 'manual'
            ? 'the user chose to hand it to you'
            : reason.kind === 'usageGuard'
              ? `it stopped because ${sourceName}'s weekly usage reached the guard, so Caxri stopped sending it requests`
              : `it stopped because ${sourceName} hit its ${windowName(reason.window)}`;
    const head = [
        `Continue the work of a ${sourceName} Chat in this Project; ${why}. The conversation so far is summarized below; you cannot ask ${sourceName} about it.`,
        'Check the working tree (`git status`, `git diff`) before acting: some steps below may be finished, half done, or uncommitted. Do not redo finished work.',
    ];
    const lastUser = snapshot.items.findLast((item) => item.type === 'userMessage');
    const sections: string[] = [];
    if (document)
        sections.push(
            `## Hand-off written by ${sourceName}\n\n${block(document, DOCUMENT_CHARACTERS)}`,
        );
    if (lastUser?.type === 'userMessage')
        sections.push(`## Latest request\n\n${block(userText(lastUser), LAST_REQUEST_CHARACTERS)}`);
    const steps = snapshot.plan?.steps ?? [];
    if (steps.length > 0)
        sections.push(
            `## Plan\n\n${steps.map((step) => `- [${step.status === 'completed' ? 'x' : ' '}] ${oneLine(step.step, ENTRY_CHARACTERS)}`).join('\n')}`,
        );
    const changed = [
        ...new Set(
            snapshot.items.flatMap((item) =>
                item.type === 'fileChange' ? item.changes.map((change) => change.path) : [],
            ),
        ),
    ];
    if (changed.length > 0)
        sections.push(
            `## Files changed in this conversation\n\n${changed
                .slice(-MAX_CHANGED_FILES)
                .map((path) => `- ${path}`)
                .join(
                    '\n',
                )}${changed.length > MAX_CHANGED_FILES ? `\n- …and ${changed.length - MAX_CHANGED_FILES} more` : ''}`,
        );
    const fixed = [...head, ...sections].join('\n\n');
    const lines = snapshot.items
        .map((item) => entry(item, sourceName))
        .filter((line): line is string => line !== undefined);
    const header = '## Recent conversation (oldest first, each entry shortened)';
    let budget = MAX_BRIEF_BYTES - bytes(fixed) - bytes(header) - 4;
    const kept: string[] = [];
    for (const line of lines.toReversed()) {
        const cost = bytes(line) + 1;
        if (cost > budget) break;
        kept.unshift(line);
        budget -= cost;
    }
    const recent = kept.length > 0 ? [`${header}\n\n${kept.join('\n')}`] : [];
    // The delegation prompt refuses terminal control characters; transcript text can carry them.
    const brief = [...head, ...sections, ...recent]
        .join('\n\n')
        // eslint-disable-next-line no-control-regex -- removing control characters is the point
        .replaceAll(/[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}-\u{9F}]/gu, ' ');
    // A hand-off or request large enough to overflow on its own is cut, so the package always fits the prompt limit.
    return bytes(brief) <= MAX_BRIEF_BYTES ? brief : truncateBytes(brief, MAX_BRIEF_BYTES);
}

function truncateBytes(text: string, limit: number): string {
    let result = '';
    let used = 0;
    for (const character of text) {
        const size = bytes(character);
        if (used + size > limit - 3) break;
        result += character;
        used += size;
    }
    return `${result}…`;
}
