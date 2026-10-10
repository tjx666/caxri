/**
 * What a web link points at, read from its URL alone so a hover card never fetches the page. A GitHub link names its
 * repository and the issue or pull request number, the way the Codex app's link card does.
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

function githubSummary(segments: readonly string[]): Pick<LinkSummary, 'detail' | 'kind'> {
    const [owner, repo, section, number] = segments;
    if (!owner) return {};
    if (!repo) return { detail: owner };
    const name = `${owner}/${repo}`;
    const kind =
        section && Object.hasOwn(GITHUB_NUMBERED, section)
            ? GITHUB_NUMBERED[section as keyof typeof GITHUB_NUMBERED]
            : undefined;
    if (kind && number && /^\d+$/u.test(number)) return { detail: `${name} · #${number}`, kind };
    return { detail: name, kind: 'repository' };
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
    const detail =
        segments.length > 0 || url.search ? safeDecode(`${url.pathname}${url.search}`) : undefined;
    return { host, ...(detail && { detail }), isSecure };
}
