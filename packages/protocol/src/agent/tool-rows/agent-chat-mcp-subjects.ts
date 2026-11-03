import type { Json } from '../trackers/agent-chat-tracker-artifact.js';
import { isRecord, parseJsonRecord, stringOf } from '../trackers/agent-chat-tracker-artifact.js';

/**
 * What an MCP tool row's title names after the tool (`Get issue LOBE-123 · Fix the login loop`), so a run of calls to
 * one tool reads as what each one touched without opening it. `isCodeSubject` marks identifiers and URLs.
 */
export interface AgentChatMcpSubject {
    subject: string;
    isCodeSubject: boolean;
}

interface McpCall {
    server: string;
    tool: string;
    /**
     * The arguments as JSON, as Server Core keeps them for an MCP call.
     */
    summary?: string;
    output?: string;
}

/**
 * A summary that is not JSON (a history recorded before Server Core kept MCP arguments as JSON, or a provider that
 * passed a bare string) stands in as the subject only when it reads as one short line.
 */
const MAX_RAW_SUMMARY_SUBJECT_LENGTH = 200;

const LINEAR_IDENTIFIER = /^[A-Z][A-Z\d]*-\d+$/u;

/**
 * One string field of a tool result. A result Server Core cut to its output limit no longer parses, so a field near its
 * start (an issue's `title` comes before its description) is still read from the raw text.
 */
function outputField(record: Json | undefined, output: string | undefined, key: string) {
    const parsed = stringOf(record?.[key]);
    if (parsed || record || !output) return parsed;
    const match = new RegExp(String.raw`"${key}"\s*:\s*"((?:[^"\\]|\\.)*)"`, 'u').exec(output);
    if (!match) return;
    try {
        return stringOf(JSON.parse(`"${match[1]}"`));
    } catch {
        return;
    }
}

/**
 * The record a result describes: the result itself, or the one object it wraps (`{ "issue": { ... } }`).
 */
function resultRecord(output: string | undefined): Json | undefined {
    const result = parseJsonRecord(output);
    if (!result) return undefined;
    const values = Object.values(result);
    const [only] = values;
    return values.length === 1 && isRecord(only) ? only : result;
}

const code = (subject: string): AgentChatMcpSubject => ({ subject, isCodeSubject: true });
const prose = (subject: string): AgentChatMcpSubject => ({ subject, isCodeSubject: false });

/**
 * A URL without its scheme, plus how many more the call named: `example.com/docs +2`.
 */
function urlsSubject(arguments_: Json): AgentChatMcpSubject | undefined {
    const urls = (Array.isArray(arguments_.urls) ? arguments_.urls : [arguments_.url]).filter(
        (url): url is string => typeof url === 'string' && url.trim() !== '',
    );
    const [first] = urls;
    if (!first) return undefined;
    const readable = first.replace(/^https?:\/\//u, '').replace(/\/$/u, '');
    return code(urls.length > 1 ? `${readable} +${urls.length - 1}` : readable);
}

/**
 * Linear's issue tools name the issue (`LOBE-123 · Fix the login loop`): the identifier from the arguments or the
 * result, and the title the result returned, which is the part a reader recognizes.
 */
function linearIssueSubject(
    arguments_: Json,
    output: string | undefined,
): AgentChatMcpSubject | undefined {
    const record = resultRecord(output);
    const resultId = outputField(record, output, 'identifier') ?? outputField(record, output, 'id');
    const argumentId = stringOf(arguments_.id) ?? stringOf(arguments_.issueId);
    const identifier = [argumentId, resultId].find((id) => id && LINEAR_IDENTIFIER.test(id));
    const title = outputField(record, output, 'title') ?? stringOf(arguments_.title);
    const subject = [identifier, title?.trim()].filter(Boolean).join(' · ');
    if (!subject) return argumentId ? code(argumentId) : undefined;
    return title ? prose(subject) : code(subject);
}

/**
 * Filters a list call names when it has no search text, as `key: value`.
 */
const LIST_FILTER_KEYS = [
    'assignee',
    'team',
    'project',
    'state',
    'label',
    'cycle',
    'parentId',
] as const;

function linearSubject(
    tool: string,
    arguments_: Json,
    output: string | undefined,
): AgentChatMcpSubject | undefined {
    if (/^(?:get|create|update|save)_issue$/u.test(tool))
        return linearIssueSubject(arguments_, output);
    if (/_comments?$/u.test(tool)) {
        const issue = stringOf(arguments_.issueId);
        return issue ? code(issue) : undefined;
    }
    if (tool.startsWith('list_')) {
        const query = stringOf(arguments_.query);
        if (query) return prose(query);
        const key = LIST_FILTER_KEYS.find((candidate) => stringOf(arguments_[candidate]));
        return key ? code(`${key}: ${stringOf(arguments_[key])}`) : undefined;
    }
    return undefined;
}

/**
 * Argument fields that name what a call acts on, in precedence order, for any server without its own rule. Identifiers
 * and URLs read as code; search text, titles, and names as prose.
 */
const SUBJECT_FIELDS: ReadonlyArray<{ key: string; isCode: boolean }> = [
    { key: 'query', isCode: false },
    { key: 'q', isCode: false },
    { key: 'id', isCode: true },
    { key: 'identifier', isCode: true },
    { key: 'issueId', isCode: true },
    { key: 'title', isCode: false },
    { key: 'name', isCode: false },
    { key: 'path', isCode: true },
    { key: 'prompt', isCode: false },
];

function genericSubject(arguments_: Json): AgentChatMcpSubject | undefined {
    for (const { key, isCode } of SUBJECT_FIELDS) {
        const value = stringOf(arguments_[key]);
        if (value) return isCode ? code(value) : prose(value);
    }
    return urlsSubject(arguments_);
}

/**
 * The subject of an MCP call's row: Linear issue and comment tools and Exa's search and fetch get rules of their own,
 * and any other server shows its first argument that names a target (`query`, `id`, `title`, `url`, ...), the way
 * LobeHub's tool inspectors show one primary argument beside the tool.
 */
export function agentChatMcpSubject(call: McpCall): AgentChatMcpSubject | undefined {
    const arguments_ = parseJsonRecord(call.summary);
    if (!arguments_) {
        const raw = call.summary?.trim();
        return raw && !raw.includes('\n') && raw.length <= MAX_RAW_SUMMARY_SUBJECT_LENGTH
            ? prose(raw)
            : undefined;
    }
    const server = call.server.toLowerCase();
    const tool = call.tool.toLowerCase();
    if (server.includes('linear')) {
        const subject = linearSubject(tool, arguments_, call.output);
        if (subject) return subject;
    }
    if (server.includes('exa') && tool.includes('fetch')) {
        const subject = urlsSubject(arguments_);
        if (subject) return subject;
    }
    return genericSubject(arguments_);
}
