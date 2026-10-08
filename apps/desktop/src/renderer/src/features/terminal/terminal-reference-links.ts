import type { TerminalReferenceLinkRule } from '@caxri/protocol';
import {
    MAX_TERMINAL_REFERENCE_IDENTIFIER_LENGTH,
    TERMINAL_REFERENCE_NUMBER_PLACEHOLDER,
} from '@caxri/protocol';

interface GitHubRepoReference {
    owner: string;
    repo: string;
}

export interface TerminalLinkReferenceContext {
    githubRepositories: readonly GitHubRepoReference[];
    rules: readonly TerminalReferenceLinkRule[];
}

export interface TerminalReferenceMatch {
    accessibleName: string;
    detail: string;
    endIndex: number;
    hint: string;
    /**
     * Marks the declarative references (commits, GitHub issues, configured rules) that carry a hover preview card. A
     * plain URL or file path is a link, not a reference: there is nothing to look up and nothing to show.
     */
    isReference: true;
    kind: 'commit' | 'url';
    overridesFile: boolean;
    startIndex: number;
    target: string;
    text: string;
}

function escapeRegex(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function referenceHint(action: string): string {
    return `⌘ click to ${action}`;
}

function githubMatch(
    text: string,
    startIndex: number,
    endIndex: number,
    owner: string,
    repo: string,
    number: string,
): TerminalReferenceMatch {
    const reference = text.slice(startIndex, endIndex);
    const target = `https://github.com/${owner}/${repo}/issues/${number}`;
    return {
        accessibleName: `Open GitHub issue or pull request ${reference}`,
        detail: `${owner}/${repo} on GitHub`,
        endIndex,
        hint: referenceHint(`open ${reference} on GitHub`),
        isReference: true,
        kind: 'url',
        overridesFile: true,
        startIndex,
        target,
        text: reference,
    };
}

function isOverlapping(
    match: Pick<TerminalReferenceMatch, 'endIndex' | 'startIndex'>,
    spans: ReadonlyArray<Pick<TerminalReferenceMatch, 'endIndex' | 'startIndex'>>,
): boolean {
    return spans.some(
        (span) => match.startIndex < span.endIndex && match.endIndex > span.startIndex,
    );
}

function uniqueGitHubRepositories(
    repositories: readonly GitHubRepoReference[],
): GitHubRepoReference[] {
    const unique = new Map<string, GitHubRepoReference>();
    for (const repo of repositories) {
        const key = `${repo.owner}/${repo.repo}`.toLowerCase();
        if (!unique.has(key)) unique.set(key, repo);
    }
    return unique.values().toArray();
}

function configuredReferenceMatches(
    text: string,
    rules: readonly TerminalReferenceLinkRule[],
): TerminalReferenceMatch[] {
    const matches: TerminalReferenceMatch[] = [];
    for (const rule of rules) {
        const identifier = rule.alphanumeric
            ? `[a-zA-Z0-9]{1,${MAX_TERMINAL_REFERENCE_IDENTIFIER_LENGTH}}`
            : String.raw`[1-9]\d{0,${MAX_TERMINAL_REFERENCE_IDENTIFIER_LENGTH - 1}}`;
        const pattern = new RegExp(
            `(^|[^a-zA-Z0-9])(${escapeRegex(rule.prefix)})(${identifier})(?![a-zA-Z0-9])`,
            rule.ignoreCase ? 'giu' : 'gu',
        );
        for (const match of text.matchAll(pattern)) {
            const leading = match[1];
            const startIndex = match.index + leading.length;
            const endIndex = match.index + match[0].length;
            const reference = text.slice(startIndex, endIndex);
            const number = match[3];
            if (!rule.alphanumeric || /\d/.test(number)) {
                const title = rule.title ?? `${rule.prefix} reference`;
                matches.push({
                    accessibleName: `Open ${title} ${reference}`,
                    detail: title,
                    endIndex,
                    hint: referenceHint(`open ${title} ${reference}`),
                    isReference: true,
                    kind: 'url',
                    overridesFile: false,
                    startIndex,
                    target: rule.url
                        .split(TERMINAL_REFERENCE_NUMBER_PLACEHOLDER)
                        .join(encodeURIComponent(number)),
                    text: reference,
                });
            }
        }
    }
    return matches;
}

function githubReferenceMatches(
    text: string,
    repositories: readonly GitHubRepoReference[],
): TerminalReferenceMatch[] {
    const matches: TerminalReferenceMatch[] = [];
    const explicitPattern =
        /(^|[^\w.-])([a-z\d](?:[a-z\d-]{0,38}[a-z\d])?)\/([\w.-]+)#([1-9]\d*)\b/giu;
    for (const match of text.matchAll(explicitPattern)) {
        const startIndex = match.index + match[1].length;
        matches.push(
            githubMatch(
                text,
                startIndex,
                match.index + match[0].length,
                match[2],
                match[3],
                match[4],
            ),
        );
    }

    const uniqueRepositories = uniqueGitHubRepositories(repositories);
    const repoPattern = /(^|[^\w./-])([\w.-]+)#([1-9]\d*)\b/giu;
    for (const match of text.matchAll(repoPattern)) {
        const startIndex = match.index + match[1].length;
        const endIndex = match.index + match[0].length;
        if (isOverlapping({ startIndex, endIndex }, matches)) continue;
        const candidates = uniqueRepositories.filter(
            ({ repo }) => repo.toLowerCase() === match[2].toLowerCase(),
        );
        if (candidates.length !== 1) continue;
        matches.push(
            githubMatch(
                text,
                startIndex,
                endIndex,
                candidates[0].owner,
                candidates[0].repo,
                match[3],
            ),
        );
    }

    if (uniqueRepositories.length === 1) {
        const repo = uniqueRepositories[0];
        const barePattern = /(^|[^\w#])#([1-9]\d*)\b/giu;
        for (const match of text.matchAll(barePattern)) {
            const startIndex = match.index + match[1].length;
            const endIndex = match.index + match[0].length;
            if (isOverlapping({ startIndex, endIndex }, matches)) continue;
            matches.push(githubMatch(text, startIndex, endIndex, repo.owner, repo.repo, match[2]));
        }
    }
    return matches;
}

function commitReferenceMatches(text: string): TerminalReferenceMatch[] {
    const matches: TerminalReferenceMatch[] = [];
    const pattern = /(^|[^a-z\d])([\da-f]{7,40})(?![a-z\d])/giu;
    for (const match of text.matchAll(pattern)) {
        const startIndex = match.index + match[1].length;
        const endIndex = match.index + match[0].length;
        const reference = match[2];
        if (!/[a-f]/i.test(reference)) continue;
        if (text[startIndex - 1] === '#' || text[startIndex - 1] === '-' || text[endIndex] === '-')
            continue;
        matches.push({
            accessibleName: `Show Git commit ${reference}`,
            detail: 'Git commit',
            endIndex,
            hint: referenceHint(`show commit ${reference} in Git`),
            isReference: true,
            kind: 'commit',
            overridesFile: false,
            startIndex,
            target: reference.toLowerCase(),
            text: reference,
        });
    }
    return matches;
}

/**
 * Detects only bounded, declarative references. Git validity is deliberately checked at activation time so xterm line
 * discovery and scrollback scanning stay synchronous and never spawn Git or issue IPC requests.
 */
export function findTerminalReferenceLinks(
    text: string,
    context: TerminalLinkReferenceContext,
): TerminalReferenceMatch[] {
    const configured = configuredReferenceMatches(text, context.rules);
    const github = githubReferenceMatches(text, context.githubRepositories).filter(
        (match) => !isOverlapping(match, configured),
    );
    const external = [...configured, ...github];
    const commits = commitReferenceMatches(text).filter((match) => !isOverlapping(match, external));
    return [...external, ...commits].toSorted(
        (left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex,
    );
}
