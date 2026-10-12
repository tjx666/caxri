import type { AgentChatItem } from '@caxri/protocol';
import { parseAgentMcpToolName, unwrapShellCommand } from '@caxri/protocol';

/**
 * A pull request, issue, or LobeHub acceptance report the Agent created or updated during a turn, shown as a card under
 * the turn's reply the way the Codex app and LobeHub surface what an Agent filed.
 */
export interface AgentChatTrackerArtifact {
    provider: 'github' | 'linear' | 'lobehub';
    kind: 'pull' | 'issue' | 'acceptance';
    action: 'created' | 'updated';
    url: string;
    /**
     * `owner/repo#12` for GitHub, the issue identifier (`ENG-123`) for Linear, and `Round 2` (or the short acceptance
     * id when the round is unknown) for an acceptance report.
     */
    reference: string;
    title?: string;
    /**
     * The first line of prose in the body, without Markdown heading or list markers.
     */
    excerpt?: string;
}

type CommandItem = Extract<AgentChatItem, { type: 'command' }>;
type ToolCallItem = Extract<AgentChatItem, { type: 'toolCall' }>;

const GITHUB_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/gu;
const LINEAR_URL = /https:\/\/linear\.app\/[\w.-]+\/issue\/([A-Z][\dA-Z]*-\d+)(?:\/[\w%-]*)?/gu;
const GH_TRACKER_COMMAND = /(?<=^|[\s;&|(])gh\s+(?:pr|issue)\s+(create|edit)\b/gu;
const LH_INGEST_COMMAND = /(?<=^|[\s;&|(])lh\s+acceptance\s+run\s+ingest\b/gu;
/**
 * The acceptance page `lh acceptance run ingest` prints: the absolute `acceptanceUrl` in `--json` output, or the bare
 * `/acceptance/<id>` path in its plain output. A bare path must not continue another path, so the local report
 * directory (`.records/acceptance/<name>/round-1`) is never read as the page.
 */
const ACCEPTANCE_URL = /(?:(https?:\/\/[\w.-]+(?::\d+)?)|(?<![\w./-]))\/acceptance\/([\w-]{8,})/gu;
const ACCEPTANCE_ORIGIN = 'https://app.lobehub.com';

const MAX_EXCERPT_LENGTH = 200;

/**
 * Unquoted characters that end one command in a chain or pipeline.
 */
const COMMAND_END: ReadonlySet<string> = new Set(['\n', ';', '|', '&']);

function githubUrlArtifact(
    url: string,
): Pick<AgentChatTrackerArtifact, 'kind' | 'reference' | 'url'> | undefined {
    const match = url.matchAll(GITHUB_URL).toArray().at(0);
    if (!match) return undefined;
    const [whole, owner, repo, section, number] = match;
    return {
        kind: section === 'pull' ? 'pull' : 'issue',
        reference: `${owner}/${repo}#${number}`,
        url: whole,
    };
}

/**
 * The first line of a body worth reading on one line: headings, rules, and list or quote markers are dropped, so a PR
 * body that opens `## Summary` previews its first sentence instead.
 */
export function trackerExcerpt(body: string | undefined): string | undefined {
    if (!body) return undefined;
    for (const raw of body.split('\n')) {
        const line = raw
            .trim()
            .replace(/^(?:[\-*+>]|\d+\.)\s+/u, '')
            .replaceAll(/[*_`]/gu, '')
            .trim();
        if (!line || /^#{1,6}\s/u.test(raw.trim()) || /^[-=*_]{3,}$/u.test(line)) continue;
        return line.length > MAX_EXCERPT_LENGTH
            ? `${line.slice(0, MAX_EXCERPT_LENGTH - 1)}…`
            : line;
    }
    return undefined;
}

/**
 * Splits a shell command into words the way the shell would read flags and their values: quotes group, a backslash
 * escapes outside single quotes, and a `$(...)` inside double quotes stays one piece, so a heredoc body passed as
 * `--body "$(cat <<'EOF' ... EOF)"` arrives whole. Words stop at an unquoted `&&`, `||`, `;`, `|`, or newline, which
 * end the `gh` invocation.
 */
export function shellWords(command: string): string[] {
    const words: string[] = [];
    let word: string | undefined;
    let quote: '"' | "'" | undefined;
    let depth = 0;
    const push = (): void => {
        if (word !== undefined) words.push(word);
        word = undefined;
    };
    for (let index = 0; index < command.length; index += 1) {
        const char = command.charAt(index);
        if (quote === "'") {
            if (char === "'") quote = undefined;
            else word += char;
            continue;
        }
        if (quote === '"') {
            if (char === '\\' && depth === 0 && /["$\\`]/u.test(command.charAt(index + 1))) {
                word += command.charAt(index + 1);
                index += 1;
            } else if (char === '$' && command.charAt(index + 1) === '(') {
                depth += 1;
                word += '$(';
                index += 1;
            } else if (char === ')' && depth > 0) {
                depth -= 1;
                word += char;
            } else if (char === '"' && depth === 0) {
                quote = undefined;
            } else {
                word += char;
            }
            continue;
        }
        if (COMMAND_END.has(char)) break;
        if (char === "'" || char === '"') {
            quote = char;
            word ??= '';
            continue;
        }
        if (char === '\\') {
            word = (word ?? '') + command.charAt(index + 1);
            index += 1;
            continue;
        }
        if (/\s/u.test(char)) push();
        else word = (word ?? '') + char;
    }
    push();
    return words;
}

/**
 * The text a `--body "$(cat <<'EOF' ... EOF)"` heredoc substitution expands to; any other value is returned as is.
 */
function expandHeredoc(value: string): string {
    const trimmed = value.trim();
    const opener = /^\$\(cat\s+<<-?\s*["']?(\w+)["']?[ \t]*\n/u.exec(trimmed);
    if (!opener?.[1] || !trimmed.endsWith(')')) return value;
    const lines = trimmed.slice(opener[0].length).split('\n');
    const end = lines.findIndex((line) => line.trim() === opener[1]);
    return end === -1 ? value : lines.slice(0, end).join('\n');
}

function flagValue(words: readonly string[], long: string, short?: string): string | undefined {
    let value: string | undefined;
    for (const [index, word] of words.entries()) {
        if (word === long || word === short) value = words[index + 1];
        else if (word.startsWith(`${long}=`)) value = word.slice(long.length + 1);
    }
    return value;
}

/**
 * Whether `index` falls inside a quoted string, so `git commit -m "explain gh pr edit"` is not read as a `gh` call.
 */
function isQuotedAt(command: string, index: number): boolean {
    let quote: '"' | "'" | undefined;
    for (let position = 0; position < index; position += 1) {
        const char = command.charAt(position);
        if (char === '\\' && quote !== "'") position += 1;
        else if (quote === undefined && (char === '"' || char === "'")) quote = char;
        else if (char === quote) quote = undefined;
    }
    return quote !== undefined;
}

/**
 * `gh pr create`, `gh pr edit`, `gh issue create`, or `gh issue edit` that printed the URL of what it touched. The
 * title and body come from the command's own flags; an edit that changed neither still names the pull request or
 * issue.
 */
function commandTrackerArtifact(item: CommandItem): AgentChatTrackerArtifact | undefined {
    if (item.status !== 'completed') return undefined;
    const command = unwrapShellCommand(item.command);
    const match = command
        .matchAll(GH_TRACKER_COMMAND)
        .find((candidate) => !isQuotedAt(command, candidate.index));
    const url = item.output.matchAll(GITHUB_URL).toArray().at(-1)?.[0];
    const target = url && githubUrlArtifact(url);
    if (!match || !target) return undefined;
    const words = shellWords(command.slice(match.index));
    const title = flagValue(words, '--title', '-t');
    const body = flagValue(words, '--body', '-b');
    const excerpt = trackerExcerpt(body === undefined ? undefined : expandHeredoc(body));
    return {
        provider: 'github',
        ...target,
        action: match[1] === 'create' ? 'created' : 'updated',
        ...(title && { title }),
        ...(excerpt && { excerpt }),
    };
}

/**
 * A positive integer field of `lh --json` output, or the `?r=<round>` of a printed round URL for `roundIndex`.
 */
function ingestNumber(output: string, key: 'cases' | 'roundIndex'): number | undefined {
    const match =
        new RegExp(String.raw`"${key}"\s*:\s*(\d+)`, 'u').exec(output) ??
        (key === 'roundIndex' ? /\/acceptance\/[\w-]+\?r=(\d+)/u.exec(output) : null);
    const value = Number(match?.[1]);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * `lh acceptance run ingest` that published a round of an acceptance report. The first round creates the report; a
 * round appended with `--acceptance <id>` updates it. The title comes from `--title` or the first round's
 * `--requirement` only when written literally, since a `"$VAR"` value never reaches the transcript expanded.
 */
function commandAcceptanceArtifact(item: CommandItem): AgentChatTrackerArtifact | undefined {
    if (item.status !== 'completed') return undefined;
    const command = unwrapShellCommand(item.command);
    const match = command
        .matchAll(LH_INGEST_COMMAND)
        .find((candidate) => !isQuotedAt(command, candidate.index));
    const printed = item.output.matchAll(ACCEPTANCE_URL).toArray().at(-1);
    if (!match || !printed?.[2]) return undefined;
    const [, origin = ACCEPTANCE_ORIGIN, id] = printed;
    const words = shellWords(command.slice(match.index));
    const round = ingestNumber(item.output, 'roundIndex');
    const cases = ingestNumber(item.output, 'cases');
    const isAppended = flagValue(words, '--acceptance') !== undefined;
    const title = [flagValue(words, '--title'), flagValue(words, '--requirement')].find(
        (value) => value?.trim() && !value.includes('$'),
    );
    return {
        provider: 'lobehub',
        kind: 'acceptance',
        action: (round === undefined ? isAppended : round > 1) ? 'updated' : 'created',
        url: `${origin}/acceptance/${id}`,
        reference: round === undefined ? id.slice(0, 8) : `Round ${round}`,
        ...(title && { title }),
        ...(cases && { excerpt: `${cases} ${cases === 1 ? 'check' : 'checks'}` }),
    };
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJsonRecord(text: string | undefined): Json | undefined {
    if (!text) return undefined;
    try {
        const value: unknown = JSON.parse(text.trim());
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

const stringOf = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined;

/**
 * The record that describes the issue or pull request: the result itself, or one level down when the server wraps it
 * (`{ "issue": { ... } }`).
 */
function trackerRecord(result: Json | undefined): Json | undefined {
    if (!result) return undefined;
    if (stringOf(result.url) ?? stringOf(result.html_url)) return result;
    return Object.values(result).find(
        (value): value is Json =>
            isRecord(value) && Boolean(stringOf(value.url) ?? stringOf(value.html_url)),
    );
}

/**
 * Which tracker operation an MCP tool performs, from its tool name: the official GitHub MCP server's
 * `create_pull_request`, `update_pull_request`, `create_issue`, `update_issue`, and `issue_write`, and the Linear MCP
 * server's `create_issue`, `update_issue`, and `save_issue`.
 */
function mcpOperation(
    name: string,
): { provider: AgentChatTrackerArtifact['provider']; tool: string } | undefined {
    const mcp = parseAgentMcpToolName(name);
    if (!mcp) return undefined;
    const server = mcp.server.toLowerCase();
    const tool = mcp.tool.toLowerCase();
    if (server.includes('linear') && /^(?:create|update|save)_issue$/u.test(tool))
        return { provider: 'linear', tool };
    if (
        server.includes('github') &&
        /^(?:(?:create|update)_(?:pull_request|issue)|issue_write)$/u.test(tool)
    )
        return { provider: 'github', tool };
    return undefined;
}

/**
 * Linear's `save_issue` both creates and updates. An `id` in the arguments targets an existing issue; otherwise a
 * result updated well after it was created is an edit of an older issue.
 */
function isLinearSaveUpdate(arguments_: Json | undefined, record: Json | undefined): boolean {
    if (stringOf(arguments_?.id)) return true;
    const created = Date.parse(stringOf(record?.createdAt) ?? '');
    const updated = Date.parse(stringOf(record?.updatedAt) ?? '');
    return Number.isFinite(created) && Number.isFinite(updated) && updated - created > 60_000;
}

function mcpAction(
    tool: string,
    arguments_: Json | undefined,
    record: Json | undefined,
): AgentChatTrackerArtifact['action'] {
    if (tool.startsWith('create_')) return 'created';
    if (tool.startsWith('update_')) return 'updated';
    if (tool === 'issue_write') return arguments_?.method === 'update' ? 'updated' : 'created';
    return isLinearSaveUpdate(arguments_, record) ? 'updated' : 'created';
}

/**
 * A GitHub or Linear MCP call that created or edited an issue or pull request. The result names the URL, title, and
 * body; arguments fill in what the result left out. Claude Code summarizes arguments by one field rather than as JSON,
 * so they are read only when the summary parses.
 */
function toolCallTrackerArtifact(item: ToolCallItem): AgentChatTrackerArtifact | undefined {
    if (item.status !== 'completed') return undefined;
    const operation = mcpOperation(item.name);
    if (!operation) return undefined;
    const arguments_ = parseJsonRecord(item.summary);
    const record = trackerRecord(parseJsonRecord(item.output));
    const title = stringOf(record?.title) ?? stringOf(arguments_?.title);
    const excerpt = trackerExcerpt(
        stringOf(record?.body) ??
            stringOf(record?.description) ??
            stringOf(arguments_?.body) ??
            stringOf(arguments_?.description),
    );
    const action = mcpAction(operation.tool, arguments_, record);
    const details = { action, ...(title && { title }), ...(excerpt && { excerpt }) };
    if (operation.provider === 'github') {
        const url =
            stringOf(record?.html_url) ??
            (item.output ?? '').matchAll(GITHUB_URL).toArray().at(-1)?.[0];
        const target = url && githubUrlArtifact(url);
        if (!target) return undefined;
        return { provider: 'github', ...target, ...details };
    }
    const linearUrl = (item.output ?? '').matchAll(LINEAR_URL).toArray().at(-1);
    const url = stringOf(record?.url) ?? linearUrl?.[0];
    const identifier =
        stringOf(record?.identifier) ?? (url && url.matchAll(LINEAR_URL).toArray().at(0)?.[1]);
    if (!url || !identifier) return undefined;
    return { provider: 'linear', kind: 'issue', url, reference: identifier, ...details };
}

/**
 * Every issue, pull request, and acceptance report the items created or edited, once each in the order first touched. A
 * later edit keeps `created` when the same turn also created it, and fills in a newer title, body, or round.
 */
export function collectAgentChatTrackers(
    items: readonly AgentChatItem[],
): AgentChatTrackerArtifact[] {
    const byUrl = new Map<string, AgentChatTrackerArtifact>();
    for (const item of items) {
        const artifact =
            item.type === 'command'
                ? (commandTrackerArtifact(item) ?? commandAcceptanceArtifact(item))
                : item.type === 'toolCall'
                  ? toolCallTrackerArtifact(item)
                  : undefined;
        if (!artifact) continue;
        const previous = byUrl.get(artifact.url);
        byUrl.set(
            artifact.url,
            previous
                ? {
                      ...previous,
                      ...artifact,
                      action: previous.action === 'created' ? 'created' : artifact.action,
                  }
                : artifact,
        );
    }
    return byUrl.values().toArray();
}
