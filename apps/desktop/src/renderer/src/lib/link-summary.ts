import type { TerminalReferencePreview } from '@caxri/protocol';

/**
 * What a web link points at, read from its URL alone so a hover card has something to show before Main reads the page
 * (see `links.preview`). A GitHub link names its repository and the issue or pull request number, the way the Codex
 * app's link card does.
 */
export interface LinkSummary {
    /**
     * The hostname without a leading `www.`.
     */
    host: string;
    /**
     * Where on the site the link leads, or `undefined` for the site's root.
     */
    detail?: string;
    /**
     * What a GitHub link opens, so its card can show the matching glyph.
     */
    kind?: 'pull' | 'issue' | 'discussion' | 'repository';
    /**
     * The issue or pull request a numbered GitHub link opens, so a transcript can ask for its state.
     */
    reference?: { owner: string; repo: string; number: number };
    /**
     * The issue a `linear.app/<workspace>/issue/<identifier>` link opens, so its card can read the title and
     * description the signed-in page hides from an anonymous fetch.
     */
    linearIssue?: { workspace: string; identifier: string };
    /**
     * Whether the host's own favicon can load under the Renderer's `img-src https:` policy.
     */
    isSecure: boolean;
}

const GITHUB_NUMBERED = {
    pull: 'pull',
    issues: 'issue',
    discussions: 'discussion',
} as const satisfies Record<string, LinkSummary['kind']>;

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function isGitHubHost(host: string): boolean {
    return host === 'github.com' || host.endsWith('.github.com');
}

function githubSummary(
    segments: readonly string[],
): Pick<LinkSummary, 'detail' | 'kind' | 'reference'> {
    const [owner, repo, section, number] = segments;
    if (!owner) return {};
    if (!repo) return { detail: owner };
    const name = `${owner}/${repo}`;
    const kind =
        section && Object.hasOwn(GITHUB_NUMBERED, section)
            ? GITHUB_NUMBERED[section as keyof typeof GITHUB_NUMBERED]
            : undefined;
    if (kind && number && /^\d+$/u.test(number))
        return {
            detail: `${name} · #${number}`,
            kind,
            ...(kind !== 'discussion' && { reference: { owner, repo, number: Number(number) } }),
        };
    return { detail: name, kind: 'repository' };
}

function linearIssueSummary(
    segments: readonly string[],
): Pick<LinkSummary, 'detail' | 'linearIssue'> | undefined {
    const [workspace, section, identifier] = segments;
    if (!workspace || section !== 'issue' || !identifier) return undefined;
    if (!/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/u.test(identifier)) return undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(workspace)) return undefined;
    const normalized = identifier.toUpperCase();
    return { detail: normalized, linearIssue: { workspace, identifier: normalized } };
}

export function linkSummary(href: string): LinkSummary | undefined {
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const host = url.hostname.replace(/^www\./u, '');
    const segments = url.pathname.split('/').filter(Boolean).map(safeDecode);
    const isSecure = url.protocol === 'https:';
    if (isGitHubHost(host)) return { host, ...githubSummary(segments), isSecure };
    const linear = host === 'linear.app' ? linearIssueSummary(segments) : undefined;
    if (linear) return { host, ...linear, isSecure };
    const detail =
        segments.length > 0 || url.search ? safeDecode(`${url.pathname}${url.search}`) : undefined;
    return { host, ...(detail && { detail }), isSecure };
}

/**
 * The lifecycle a pull request link's icon shows, read from the Server's reference preview. `undefined` while the state
 * is unknown (still loading, not a pull request, or GitHub could not answer), so the icon falls back to a plain one.
 */
export function pullRequestLinkState(
    preview: TerminalReferencePreview | undefined,
): 'closed' | 'draft' | 'merged' | 'open' | undefined {
    if (preview?.kind !== 'github' || !preview.isPullRequest) return undefined;
    if (preview.isMerged) return 'merged';
    if (preview.state === 'closed') return 'closed';
    return preview.isDraft ? 'draft' : 'open';
}
