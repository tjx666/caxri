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
     * `owner/repo#12` for GitHub, the issue identifier (`ENG-123`) for Linear, and the short report id for an
     * acceptance report. Display through `trackerReferenceText()`, which prefers an acceptance report's round.
     */
    reference: string;
    title?: string;
    /**
     * The first line of prose in the body, without Markdown heading or list markers.
     */
    excerpt?: string;
    /**
     * The acceptance round the report reached, when the ingest output reported one.
     */
    round?: number;
    /**
     * How many checks the acceptance round ran. Display through `trackerExcerptText()`.
     */
    checks?: number;
    /**
     * A Linear issue's workflow state after the call, as the Linear MCP result reports it. `name` is the team's own
     * label (`In Progress`); `type` is Linear's fixed category, absent when only the requested state name is known.
     */
    status?: AgentChatTrackerStatus;
}

/**
 * Linear's fixed workflow state categories, which every team-defined state belongs to.
 */
export const AGENT_CHAT_TRACKER_STATUS_TYPES = [
    'triage',
    'backlog',
    'unstarted',
    'started',
    'completed',
    'canceled',
] as const;

export type AgentChatTrackerStatusType = (typeof AGENT_CHAT_TRACKER_STATUS_TYPES)[number];

export interface AgentChatTrackerStatus {
    name: string;
    type?: AgentChatTrackerStatusType;
}

/**
 * The card's reference line in English, for the phone: an acceptance report's round when the ingest output reported
 * one, else the reference. Desktop localizes the round at render time instead, because its collected timeline is
 * memoized and would keep the language it was first built in.
 */
export function trackerReferenceText(artifact: AgentChatTrackerArtifact): string {
    return artifact.round === undefined ? artifact.reference : `Round ${artifact.round}`;
}

/**
 * The card's excerpt line in English, for the phone: an acceptance report's check count, else the body's first line.
 */
export function trackerExcerptText(artifact: AgentChatTrackerArtifact): string | undefined {
    if (artifact.checks === undefined) return artifact.excerpt;
    return `${artifact.checks} ${artifact.checks === 1 ? 'check' : 'checks'}`;
}

export const GITHUB_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/gu;
export const LINEAR_URL =
    /https:\/\/linear\.app\/[\w.-]+\/issue\/([A-Z][\dA-Z]*-\d+)(?:\/[\w%-]*)?/gu;

const MAX_EXCERPT_LENGTH = 200;

export function githubUrlArtifact(
    url: string,
): Pick<AgentChatTrackerArtifact, 'kind' | 'reference' | 'url'> | undefined {
    const match = Array.from(url.matchAll(GITHUB_URL)).at(0);
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
export function agentChatTrackerExcerpt(body: string | undefined): string | undefined {
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

export type Json = Record<string, unknown>;

export const isRecord = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseJsonRecord(text: string | undefined): Json | undefined {
    if (!text) return undefined;
    try {
        const value: unknown = JSON.parse(text.trim());
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

export const stringOf = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined;
