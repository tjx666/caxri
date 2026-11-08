import { compareStableVersions } from '@caxri/protocol';
import { z } from 'zod';

import type { SourceMapFlavor } from '../source-map-flavor';
import { releaseDmgFileName } from '../source-map-flavor';
import type { AvailableRelease } from './update-download';
import { MAX_CHECKSUM_BYTES, MAX_DMG_BYTES, UpdateFailure } from './update-transport';

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/tjx666/caxri/releases/latest';

/**
 * The web page behind the same "latest stable release" answer. GitHub serves it as a `302` to `/releases/tag/v<x.y.z>`
 * and, unlike `api.github.com`, does not bill it against the anonymous 60-requests-an-hour API quota. That quota is
 * keyed by the public IP, so a proxy exit or office NAT shared with other anonymous API callers can stay exhausted for
 * the whole hour regardless of how rarely Caxri itself checks; the redirect keeps discovery working through it.
 */
export const LATEST_RELEASE_PAGE_URL = 'https://github.com/tjx666/caxri/releases/latest';

const RELEASE_TAG_PATH = /^\/tjx666\/caxri\/releases\/tag\/v([^/]+)$/;
const RELEASE_DOWNLOAD_BASE = 'https://github.com/tjx666/caxri/releases/download';

const releaseAssetSchema = z.object({
    name: z.string(),
    size: z.number().int().nonnegative(),
    browser_download_url: z.url(),
});

const releaseSchema = z.object({
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

function isExactReleaseAssetUrl(url: string, version: string, fileName: string): boolean {
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

/**
 * Validates the body of a successful `releases/latest` answer and returns the release when it is newer than
 * `currentVersion`, or `undefined` when it is not. Throws on malformed or untrusted metadata. Shared by the visible
 * check and the silent look for a newer release while one is already staged.
 */
export function parseLatestRelease(
    source: string,
    currentVersion: string,
    sourceMapFlavor: SourceMapFlavor,
): AvailableRelease | undefined {
    let json: unknown;
    try {
        json = JSON.parse(source) as unknown;
    } catch {
        throw new Error('GitHub returned invalid release metadata.');
    }
    const parsedRelease = releaseSchema.safeParse(json);
    if (!parsedRelease.success) throw new Error('GitHub returned invalid release metadata.');
    const release = parsedRelease.data;
    if (release.draft || release.prerelease)
        throw new Error('GitHub returned a non-stable release.');
    const version = release.tag_name.replace(/^v/, '');
    assertStableVersion(version);
    assertStableVersion(currentVersion);
    if (compareStableVersions(version, currentVersion) <= 0) return undefined;

    const releaseUrl = releasePageUrl(release.html_url);
    const fileName = releaseDmgFileName(version, sourceMapFlavor);
    const checksumName = `${fileName}.sha256`;
    const dmg = release.assets.find((asset) => asset.name === fileName);
    const checksum = release.assets.find((asset) => asset.name === checksumName);
    if (!dmg || !checksum)
        throw new UpdateFailure('integrity', 'The release is missing its arm64 DMG or checksum.');
    if (dmg.size > MAX_DMG_BYTES || checksum.size > MAX_CHECKSUM_BYTES)
        throw new UpdateFailure(
            'integrity',
            'A release asset is larger than the allowed update size.',
        );
    if (
        !isExactReleaseAssetUrl(dmg.browser_download_url, version, fileName) ||
        !isExactReleaseAssetUrl(checksum.browser_download_url, version, checksumName)
    ) {
        throw new UpdateFailure(
            'integrity',
            'A release asset URL does not match the requested version.',
        );
    }
    return {
        version,
        fileName,
        dmgUrl: dmg.browser_download_url,
        checksumUrl: checksum.browser_download_url,
        ...(releaseUrl && { releaseUrl }),
        ...(dmg.size > 0 && { expectedBytes: dmg.size }),
    };
}

/**
 * Reads the latest stable release from {@link LATEST_RELEASE_PAGE_URL}'s redirect `location` and returns it when it is
 * newer than `currentVersion`, or `undefined` when it is not. Throws when the redirect does not name a stable release
 * tag of this repository.
 *
 * The page carries no asset list, so the DMG and checksum URLs are derived from the same `releases/download/v<x.y.z>`
 * pattern `parseLatestRelease` requires of the API's URLs, and `expectedBytes` is left out. Nothing is trusted less:
 * the download still verifies the DMG against the published checksum and the size cap, and a release still missing an
 * asset fails that download instead of the check.
 */
export function parseLatestReleaseRedirect(
    location: string | null,
    currentVersion: string,
    sourceMapFlavor: SourceMapFlavor,
): AvailableRelease | undefined {
    let parsed: URL;
    try {
        parsed = new URL(location ?? '', LATEST_RELEASE_PAGE_URL);
    } catch {
        throw new Error('GitHub returned an invalid latest release redirect.');
    }
    const tag =
        parsed.protocol === 'https:' && parsed.hostname === 'github.com'
            ? RELEASE_TAG_PATH.exec(parsed.pathname)
            : null;
    if (!location || !tag) throw new Error('GitHub returned an invalid latest release redirect.');
    const version = decodeURIComponent(tag[1]);
    assertStableVersion(version);
    assertStableVersion(currentVersion);
    if (compareStableVersions(version, currentVersion) <= 0) return undefined;

    const fileName = releaseDmgFileName(version, sourceMapFlavor);
    const releaseUrl = releasePageUrl(parsed.href);
    return {
        version,
        fileName,
        dmgUrl: `${RELEASE_DOWNLOAD_BASE}/v${version}/${fileName}`,
        checksumUrl: `${RELEASE_DOWNLOAD_BASE}/v${version}/${fileName}.sha256`,
        ...(releaseUrl && { releaseUrl }),
    };
}
