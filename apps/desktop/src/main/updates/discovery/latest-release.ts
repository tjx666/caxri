import type { SourceMapFlavor } from '../../source-map-flavor';
import type { AvailableRelease } from '../update-download';
import {
    isRateLimitedStatus,
    LATEST_RELEASE_PAGE_URL,
    LATEST_RELEASE_URL,
    parseLatestRelease,
    parseLatestReleaseRedirect,
    rateLimitResumeAt,
} from '../update-github-release';
import type { UpdateFetch } from '../update-service-contract';
import {
    assertSuccessfulResponse,
    MAX_RELEASE_RESPONSE_BYTES,
    readBoundedResponse,
} from '../update-transport';

const CHECK_TIMEOUT_MS = 15_000;

/**
 * What one look for the latest release found: a release (`undefined` when it is not newer than this build), a feed that
 * is not published, or GitHub limiting both the API and the release page.
 */
export type LatestReleaseDiscovery =
    | { kind: 'feed-unavailable' }
    | { kind: 'rate-limited'; retryAt?: number }
    | { kind: 'release'; release: AvailableRelease | undefined };

/**
 * Finds the latest stable GitHub release for the visible check and the silent supersede, and owns the API rate-limit
 * window between them.
 *
 * GitHub's anonymous release API is subject to both a per-hour primary limit (403) and a burst secondary limit (429).
 * Both are expected, temporary conditions rather than a Caxri defect, and the primary one is keyed by the public IP, so
 * other anonymous API callers behind the same proxy or NAT can exhaust it for the whole hour. A limited answer (or a
 * still-open window from one) falls back to the release page redirect, which answers the same question outside that
 * quota; only when the page fails too does discovery report `rate-limited` (#244).
 */
export class LatestReleaseFinder {
    /**
     * Epoch millis before which discovery skips the API because GitHub already rate-limited it. `undefined` when no
     * rate limit is currently known.
     */
    private rateLimitedUntil: number | undefined;

    constructor(
        private readonly options: {
            currentVersion: string;
            fetch: UpdateFetch;
            now: () => number;
            sourceMapFlavor: SourceMapFlavor;
        },
    ) {}

    private requestApi(): Promise<Response> {
        return this.options.fetch(LATEST_RELEASE_URL, {
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
            headers: {
                'Accept': 'application/vnd.github+json',
                'User-Agent': `Caxri/${this.options.currentVersion}`,
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });
    }

    /**
     * Validates a successful `releases/latest` answer. Throws on malformed or untrusted metadata.
     */
    private async readApi(response: Response): Promise<AvailableRelease | undefined> {
        assertSuccessfulResponse(response, 'The GitHub release check');
        // A successful, non-rate-limited response means the previous rate limit (if any) has cleared.
        this.rateLimitedUntil = undefined;
        const source = new TextDecoder().decode(
            await readBoundedResponse(response, MAX_RELEASE_RESPONSE_BYTES),
        );
        return parseLatestRelease(
            source,
            this.options.currentVersion,
            this.options.sourceMapFlavor,
        );
    }

    /**
     * Reads the release page redirect without following it, which would download the page HTML.
     */
    private async readPage(): Promise<AvailableRelease | undefined> {
        const response = await this.options.fetch(LATEST_RELEASE_PAGE_URL, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
            headers: { 'User-Agent': `Caxri/${this.options.currentVersion}` },
        });
        if (response.status < 300 || response.status >= 400)
            throw new Error(`The GitHub release page answered with status ${response.status}.`);
        return parseLatestReleaseRedirect(
            response.headers.get('location'),
            this.options.currentVersion,
            this.options.sourceMapFlavor,
        );
    }

    async discover(): Promise<LatestReleaseDiscovery> {
        const { now } = this.options;
        const isLimitWindowOpen =
            this.rateLimitedUntil !== undefined && now() < this.rateLimitedUntil;
        if (!isLimitWindowOpen) {
            const response = await this.requestApi();
            // While the repository is private, the anonymous releases API returns 404 for every check. That is an
            // expected pre-release condition, not a fault, so it degrades to `unavailable` instead of surfacing a
            // permanent error on every launch (#244).
            if (response.status === 404) return { kind: 'feed-unavailable' };
            if (!isRateLimitedStatus(response.status))
                return { kind: 'release', release: await this.readApi(response) };
            // Remembered so later checks skip the API until it resets instead of re-triggering the same limit.
            this.rateLimitedUntil = rateLimitResumeAt(response, now());
        }
        try {
            return { kind: 'release', release: await this.readPage() };
        } catch {
            return {
                kind: 'rate-limited',
                ...(this.rateLimitedUntil !== undefined && { retryAt: this.rateLimitedUntil }),
            };
        }
    }
}
