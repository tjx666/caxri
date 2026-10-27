import { compareStableVersions } from '@caxri/protocol';
import { z } from 'zod';

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/tjx666/caxri/releases/latest';

const releaseAssetSchema = z.object({
    name: z.string(),
    size: z.number().int().nonnegative(),
    browser_download_url: z.url(),
});

export const releaseSchema = z.object({
    tag_name: z.string(),
    html_url: z.string().optional(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(releaseAssetSchema),
});

/**
 * Rejects a release tag Caxri cannot order. Shares `compareStableVersions`' parser so the shape Main accepts here and
 * the shape the Renderer can compare a skipped version against can never drift apart.
 */
export function assertStableVersion(version: string): void {
    compareStableVersions(version, version);
}

/**
 * The release page to link to, or `undefined` when GitHub's `html_url` is missing or does not point at this
 * repository's releases. The value reaches `shell.openExternal` through the Renderer, so it is pinned to the project
 * rather than trusted because it arrived in a GitHub response.
 */
export function releasePageUrl(htmlUrl: string | undefined): string | undefined {
    if (!htmlUrl) return undefined;
    try {
        const parsed = new URL(htmlUrl);
        return parsed.protocol === 'https:' &&
            parsed.hostname === 'github.com' &&
            parsed.pathname.startsWith('/tjx666/caxri/releases')
            ? parsed.href
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * `true` for both GitHub's primary (403, once the anonymous per-hour quota is exhausted) and secondary (429, once
 * requests arrive too quickly) rate limits on the release check. Both are expected, temporary conditions rather than a
 * Caxri defect, so they degrade to `unavailable` the same way the pre-release 404 case does (#244) instead of surfacing
 * a permanent, retried-every-launch `error`.
 */
export function isRateLimitedStatus(status: number): boolean {
    return status === 403 || status === 429;
}

/**
 * Reads GitHub's rate-limit reset hint from the response so the next automatic check can skip the network call entirely
 * until the limit clears, instead of hammering an endpoint that is already rejecting requests. `retry-after` is a
 * relative delay in seconds (used for secondary/abuse limits); `x-ratelimit-reset` is an absolute Unix epoch in seconds
 * (used for the primary hourly limit). Returns `undefined` when neither header is present, in which case the caller
 * does not open a skip window.
 */
export function rateLimitResumeAt(response: Response, now: number): number | undefined {
    const retryAfterSeconds = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0)
        return now + retryAfterSeconds * 1_000;
    const resetEpochSeconds = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0)
        return resetEpochSeconds * 1_000;
    return undefined;
}

export function isExactReleaseAssetUrl(url: string, version: string, fileName: string): boolean {
    try {
        const parsed = new URL(url);
        return (
            parsed.protocol === 'https:' &&
            parsed.hostname === 'github.com' &&
            decodeURIComponent(parsed.pathname) ===
                `/tjx666/caxri/releases/download/v${version}/${fileName}`
        );
    } catch {
        return false;
    }
}
