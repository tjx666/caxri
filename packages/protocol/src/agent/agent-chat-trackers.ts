import type { AgentChatItem } from './agent-chat-contract.js';
import { toolCallTrackerArtifact } from './agent-chat-mcp-trackers.js';
import type { AgentChatTrackerArtifact } from './agent-chat-tracker-artifact.js';
import {
    agentChatTrackerExcerpt,
    GITHUB_URL,
    githubUrlArtifact,
    parseJsonRecord,
    stringOf,
} from './agent-chat-tracker-artifact.js';
import { unwrapShellCommand } from './agent-tool-presentation.js';

type CommandItem = Extract<AgentChatItem, { type: 'command' }>;

const GH_TRACKER_COMMAND = /(?<=^|[\s;&|(])gh\s+(?:pr|issue)\s+(create|edit)\b/gu;
const LH_INGEST_COMMAND = /(?<=^|[\s;&|(])lh\s+acceptance\s+run\s+ingest\b/gu;
/**
 * The acceptance page `lh acceptance run ingest` prints: the absolute `acceptanceUrl` in `--json` output, or the bare
 * `/acceptance/<id>` path in its plain output. A bare path must not continue another path, so the local report
 * directory (`.records/acceptance/<name>/round-1`) is never read as the page.
 */
const ACCEPTANCE_URL = /(?:(https?:\/\/[\w.-]+(?::\d+)?)|(?<![\w./-]))\/acceptance\/([\w-]{8,})/gu;
const ACCEPTANCE_ORIGIN = 'https://app.lobehub.com';
const GH_API_COMMAND = /(?<=^|[\s;&|(])gh\s+api\b/gu;
/**
 * A REST endpoint that is a pull request or issue itself (`repos/o/r/pulls/12`) or its collection (`repos/o/r/issues`),
 * not a sub-resource such as comments, reviews, or labels.
 */
const GH_API_TRACKER_ENDPOINT =
    /^\/?repos\/([\w.-]+)\/([\w.-]+)\/(pulls|issues)(?:\/(\d+))?\/?(?:\?.*)?$/u;
/**
 * `gh api` flags that take a value, so the value is not mistaken for the endpoint.
 */
const GH_API_VALUE_FLAGS: ReadonlySet<string> = new Set([
    '-F',
    '-H',
    '-X',
    '-f',
    '-p',
    '-q',
    '-t',
    '--cache',
    '--field',
    '--header',
    '--hostname',
    '--input',
    '--jq',
    '--method',
    '--preview',
    '--raw-field',
    '--template',
]);

/**
 * Unquoted characters that end one command in a chain or pipeline.
 */
const COMMAND_END: ReadonlySet<string> = new Set(['\n', ';', '|', '&']);

/**
 * Splits a shell command into words the way the shell would read flags and their values: quotes group, a backslash
 * escapes outside single quotes, and a `$(...)` inside double quotes stays one piece, so a heredoc body passed as
 * `--body "$(cat <<'EOF' ... EOF)"` arrives whole. Words stop at an unquoted `&&`, `||`, `;`, `|`, or newline, which
 * end the `gh` invocation.
 */
export function agentChatTrackerShellWords(command: string): string[] {
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
 * The first match of a command pattern that is not inside a quoted argument, such as `gh pr create` quoted in another
 * command's message. A loop rather than an Iterator helper, because the phone's JavaScript engine is not guaranteed to
 * have them.
 */
function firstUnquotedMatch(command: string, pattern: RegExp): RegExpExecArray | undefined {
    for (const candidate of command.matchAll(pattern))
        if (!isQuotedAt(command, candidate.index)) return candidate;
    return undefined;
}

/**
 * The command starting at `index`, up to the unquoted operator that ends it, and whether that operator is `||`: a
 * fallback that runs only when this command fails.
 */
function commandUntilEnd(command: string, index: number): { text: string; hasFallback: boolean } {
    let quote: '"' | "'" | undefined;
    for (let position = index; position < command.length; position += 1) {
        const char = command.charAt(position);
        if (char === '\\' && quote !== "'") position += 1;
        else if (quote === undefined && (char === '"' || char === "'")) quote = char;
        else if (char === quote) quote = undefined;
        else if (quote === undefined && COMMAND_END.has(char))
            return {
                text: command.slice(index, position),
                hasFallback: char === '|' && command.charAt(position + 1) === '|',
            };
    }
    return { text: command.slice(index), hasFallback: false };
}

/**
 * Gh's error when a pull request for the branch already exists; it prints the existing pull request's URL with it.
 */
const GH_ALREADY_EXISTS = /\balready exists\b/u;
const DISCARDS_STDERR = /(?:^|\s)(?:2|&)>\s*\/dev\/null\b/u;

/**
 * Whether a printed URL may have come from the `||` fallback of a create rather than from the create itself, as in `gh
 * pr create ... || gh pr view --json url`: the create failed because the pull request exists (gh says so), or its error
 * was discarded and nothing tells the two apart. Both exit 0 and print a URL.
 */
function canBeFallbackUrl(
    segment: { text: string; hasFallback: boolean },
    output: string,
): boolean {
    return (
        segment.hasFallback &&
        (GH_ALREADY_EXISTS.test(output) || DISCARDS_STDERR.test(segment.text))
    );
}

/**
 * `gh pr create`, `gh pr edit`, `gh issue create`, or `gh issue edit` that printed the URL of what it touched. The
 * title and body come from the command's own flags; an edit that changed neither still names the pull request or issue.
 * A create is skipped when its `||` fallback may have printed the URL instead, so the next `gh` call (an edit in that
 * fallback) decides the card, or there is none.
 */
function commandTrackerArtifact(item: CommandItem): AgentChatTrackerArtifact | undefined {
    if (item.status !== 'completed') return undefined;
    const command = unwrapShellCommand(item.command);
    const url = Array.from(item.output.matchAll(GITHUB_URL)).at(-1)?.[0];
    const target = url && githubUrlArtifact(url);
    if (!target) return undefined;
    let match: RegExpExecArray | undefined;
    for (const candidate of command.matchAll(GH_TRACKER_COMMAND)) {
        if (isQuotedAt(command, candidate.index)) continue;
        const isCreate = candidate[1] === 'create';
        if (isCreate && canBeFallbackUrl(commandUntilEnd(command, candidate.index), item.output))
            continue;
        match = candidate;
        break;
    }
    if (!match) return undefined;
    const words = agentChatTrackerShellWords(command.slice(match.index));
    const title = flagValue(words, '--title', '-t');
    const body = flagValue(words, '--body', '-b');
    const excerpt = agentChatTrackerExcerpt(body === undefined ? undefined : expandHeredoc(body));
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
    const match = firstUnquotedMatch(command, LH_INGEST_COMMAND);
    const printed = Array.from(item.output.matchAll(ACCEPTANCE_URL)).at(-1);
    if (!match || !printed?.[2]) return undefined;
    const [, origin = ACCEPTANCE_ORIGIN, id] = printed;
    const words = agentChatTrackerShellWords(command.slice(match.index));
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
        reference: id.slice(0, 8),
        ...(round !== undefined && { round }),
        ...(title && { title }),
        ...(cases && { checks: cases }),
    };
}

interface GhApiCall {
    endpoint: string | undefined;
    fields: Map<string, string>;
    method: string;
}

/**
 * The endpoint, HTTP method, and `-f`/`-F` fields of a `gh api` call. Like `gh` itself, the method defaults to POST
 * once a field or `--input` is passed and to GET otherwise.
 */
function ghApiCall(words: readonly string[]): GhApiCall {
    const fields = new Map<string, string>();
    let endpoint: string | undefined;
    let method: string | undefined;
    let hasInput = false;
    for (let index = 2; index < words.length; index += 1) {
        const word = words.at(index) ?? '';
        const equals = word.startsWith('--') ? word.indexOf('=') : -1;
        const flag = equals === -1 ? word : word.slice(0, equals);
        if (!GH_API_VALUE_FLAGS.has(flag)) {
            if (!word.startsWith('-')) endpoint ??= word;
            continue;
        }
        const value = equals === -1 ? (words.at((index += 1)) ?? '') : word.slice(equals + 1);
        if (flag === '-X' || flag === '--method') method = value.toUpperCase();
        else if (flag === '--input') hasInput = true;
        else if (['-F', '-f', '--field', '--raw-field'].includes(flag)) {
            const separator = value.indexOf('=');
            if (separator > 0) fields.set(value.slice(0, separator), value.slice(separator + 1));
        }
    }
    return { endpoint, fields, method: method ?? (hasInput || fields.size > 0 ? 'POST' : 'GET') };
}

/**
 * A field value as written, or `undefined` for `-F body=@file`, whose text lives in a file the transcript never shows.
 */
const literalField = (fields: ReadonlyMap<string, string>, key: string): string | undefined => {
    const value = fields.get(key);
    return value === undefined || value.startsWith('@') ? undefined : stringOf(value);
};

/**
 * The first GitHub URL in `text` that belongs to `owner/repo`. A loop rather than an Iterator helper, because the
 * phone's JavaScript engine is not guaranteed to have them.
 */
function repoUrlIn(
    text: string,
    owner: string | undefined,
    repo: string | undefined,
): string | undefined {
    for (const candidate of text.matchAll(GITHUB_URL))
        if (candidate[1] === owner && candidate[2] === repo) return candidate[0];
    return undefined;
}

/**
 * A `gh api` call that created a pull request or issue (POST to its collection) or edited one (PATCH to it), which is
 * how an Agent updates a PR body from a file without `gh pr edit`. An edit names its target in the endpoint, so it
 * shows even when the command printed nothing; a create needs the URL from the response. Title and body come from the
 * response JSON when the command printed it, otherwise from literal fields.
 */
function ghApiTrackerArtifact(item: CommandItem): AgentChatTrackerArtifact | undefined {
    if (item.status !== 'completed') return undefined;
    const command = unwrapShellCommand(item.command);
    const match = firstUnquotedMatch(command, GH_API_COMMAND);
    if (!match) return undefined;
    const call = ghApiCall(agentChatTrackerShellWords(command.slice(match.index)));
    const endpoint = call.endpoint && GH_API_TRACKER_ENDPOINT.exec(call.endpoint);
    if (!endpoint) return undefined;
    const [, owner, repo, collection] = endpoint;
    const number = endpoint.at(4);
    const action =
        number === undefined
            ? call.method === 'POST' && 'created'
            : call.method === 'PATCH' && 'updated';
    if (!action) return undefined;
    const section = collection === 'pulls' ? 'pull' : 'issues';
    const record = parseJsonRecord(item.output);
    const url =
        number === undefined
            ? (stringOf(record?.html_url) ?? repoUrlIn(item.output, owner, repo))
            : `https://github.com/${owner}/${repo}/${section}/${number}`;
    const target = url && githubUrlArtifact(url);
    if (!target) return undefined;
    const title = stringOf(record?.title) ?? literalField(call.fields, 'title');
    const excerpt = agentChatTrackerExcerpt(
        stringOf(record?.body) ?? literalField(call.fields, 'body'),
    );
    return {
        provider: 'github',
        ...target,
        action,
        ...(title && { title }),
        ...(excerpt && { excerpt }),
    };
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
                ? (commandTrackerArtifact(item) ??
                  ghApiTrackerArtifact(item) ??
                  commandAcceptanceArtifact(item))
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
    return Array.from(byUrl.values());
}
