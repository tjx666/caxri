import type { TerminalReferencePreview, TerminalReferencePreviewRequest } from '@caxri/protocol';
import { relativeTime, rememberBounded } from '@caxri/utils';

/**
 * Long enough that re-reading the same line of output costs nothing, short enough that an issue closed in the browser
 * shows its new state without restarting Caxri. The Server holds its own, longer record; this one only keeps a hover
 * from crossing the IPC boundary at all.
 */
const PREVIEW_TTL_MS = 60_000;
/**
 * A blank card is usually a transient condition: `gh` not logged in yet, a repository still being cloned, so it is
 * remembered just long enough to stop a pointer sweeping one line from re-asking on every row.
 */
const UNAVAILABLE_TTL_MS = 15_000;
/**
 * Bounded because a fast scroll through dense output can brush hundreds of references, and each retained card holds a
 * commit message and an issue title.
 */
const MAX_PREVIEW_ENTRIES = 64;

const GITHUB_REFERENCE_PATTERN =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)$/u;

/**
 * The parts of a detected link a preview needs. Declared here rather than imported from `terminal-links.ts` so the
 * preview layer stays a leaf: link detection depends on it, never the other way round.
 */
export interface TerminalPreviewLink {
    detail?: string;
    kind: 'commit' | 'file' | 'url';
    target: string;
    text: string;
}

/**
 * One hover card's content, already reduced to plain strings.
 *
 * Every field is rendered with `textContent`, never as markup: a commit subject and an issue title are whatever a
 * stranger typed, and a Terminal is where untrusted text arrives in the first place.
 */
export interface TerminalReferencePreviewCard {
    /**
     * Message below the subject, already truncated; absent for a single-line commit or an issue.
     */
    body?: string;
    /**
     * Where the reference lives (the repository, the tracker) shown under the title.
     */
    detail?: string;
    /**
     * Short facts rendered on one row: author, age, line counts, state.
     */
    facts: string[];
    title: string;
}

export type TerminalReferencePreviewRequester = (
    terminalId: string,
    request: TerminalReferencePreviewRequest,
    signal: AbortSignal,
) => Promise<TerminalReferencePreview>;

export interface TerminalReferencePreviewStoreOptions {
    maxEntries?: number;
    now?: () => number;
    ttlMs?: number;
    unavailableTtlMs?: number;
}

interface CachedPreview {
    fetchedAt: number;
    preview: TerminalReferencePreview;
}

interface InFlightPreview {
    controller: AbortController;
    promise: Promise<TerminalReferencePreview>;
    waiters: Set<AbortSignal>;
}

/**
 * What to ask the Server about this link, or `undefined` when the card can be drawn from what the Renderer already
 * knows.
 *
 * A reference matched by a configured rule is deliberately in that second group: its card is built entirely from the
 * rule the user wrote, so hovering one costs no request and no subprocess. Only commits and GitHub issues carry
 * metadata the Renderer cannot see on its own.
 */
export function terminalReferencePreviewRequest(
    link: TerminalPreviewLink,
): TerminalReferencePreviewRequest | undefined {
    if (link.kind === 'commit')
        return /^[0-9a-f]{7,40}$/i.test(link.target)
            ? { kind: 'commit', reference: link.target.toLowerCase() }
            : undefined;
    if (link.kind !== 'url') return undefined;
    const github = GITHUB_REFERENCE_PATTERN.exec(link.target);
    if (!github) return undefined;
    const number = Number(github[3]);
    return Number.isSafeInteger(number) && number > 0
        ? { kind: 'github', owner: github[1], repo: github[2], number }
        : undefined;
}

function terminalReferencePreviewKey(
    terminalId: string,
    request: TerminalReferencePreviewRequest,
): string {
    return request.kind === 'commit'
        ? `${terminalId}:commit:${request.reference}`
        : `${terminalId}:github:${request.owner}/${request.repo}#${request.number}`;
}

/**
 * The card shown before (and instead of) any request: the reference text and where it points. Every recognized
 * reference has one, so a hover always answers something even when the CLI is missing or the repository is unknown.
 */
export function basicReferencePreviewCard(link: TerminalPreviewLink): TerminalReferencePreviewCard {
    return { detail: link.detail, facts: [], title: link.text };
}

function commitFacts(
    preview: Extract<TerminalReferencePreview, { kind: 'commit' }>,
    now: number,
): string[] {
    const facts = [preview.author, relativeTime(preview.authoredAt, now)].filter(Boolean);
    const fileLabel = preview.changedFileCount === 1 ? 'file' : 'files';
    facts.push(
        `+${preview.insertions} -${preview.deletions} in ${preview.changedFileCount} ${fileLabel}`,
    );
    return facts;
}

/**
 * Why a card stayed basic, in the user's terms. Deliberately not an error: a hover the user did not ask for must never
 * produce a notification to dismiss, so the reason is stated on the card and nowhere else.
 */
const UNAVAILABLE_FACTS: Record<
    Extract<TerminalReferencePreview, { kind: 'unavailable' }>['reason'],
    string
> = {
    'ambiguous': 'Matches more than one repository',
    'cli-missing': 'Install the GitHub CLI to see details',
    'failed': 'Details unavailable',
    'not-authenticated': 'Sign in with the GitHub CLI to see details',
    'not-found': 'No details found',
    'rate-limited': 'GitHub rate limit reached',
};

/**
 * Folds a Server answer into the basic card, so a degraded read loses the extra facts and keeps everything the Renderer
 * already knew.
 */
export function terminalReferencePreviewCard(
    link: TerminalPreviewLink,
    preview: TerminalReferencePreview,
    now: number = Date.now(),
): TerminalReferencePreviewCard {
    const basic = basicReferencePreviewCard(link);
    if (preview.kind === 'unavailable')
        return { ...basic, facts: [UNAVAILABLE_FACTS[preview.reason]] };
    if (preview.kind === 'commit')
        return {
            body: preview.body.split('\n').filter(Boolean).slice(0, 2).join(' ') || undefined,
            detail: `${preview.repositoryName} \u{00B7} ${preview.shortSha}`,
            facts: commitFacts(preview, now),
            title: preview.subject,
        };
    // GitHub reports `open` / `closed`; the fact starts a line, so it is capitalized like every other one on the card.
    const state = preview.isMerged
        ? 'Merged'
        : preview.isDraft
          ? 'Draft'
          : preview.state.charAt(0).toUpperCase() + preview.state.slice(1);
    return {
        detail: basic.detail,
        facts: [
            `${state} ${preview.isPullRequest ? 'pull request' : 'issue'} #${preview.number}`,
            preview.author,
            relativeTime(preview.createdAt, now),
        ].filter(Boolean),
        title: preview.title || basic.title,
    };
}

/**
 * Per-Terminal preview reads, deduplicated and bounded.
 *
 * Hovering is involuntary, so the two failure modes this guards are both about volume rather than correctness: sweeping
 * the pointer across a screen of references must not open one request per row, and coming back to the same reference a
 * second later must not open a second one. A read is shared by every hover waiting on it and is canceled only when the
 * last of them leaves: cancelling on the first departure would fail a card another pointer is still waiting for.
 */
export class TerminalReferencePreviewStore {
    private readonly entries = new Map<string, CachedPreview>();
    private readonly inFlight = new Map<string, InFlightPreview>();

    constructor(
        private readonly requestPreview: TerminalReferencePreviewRequester,
        private readonly options: TerminalReferencePreviewStoreOptions = {},
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private cached(key: string): TerminalReferencePreview | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        const ttl =
            entry.preview.kind === 'unavailable'
                ? (this.options.unavailableTtlMs ?? UNAVAILABLE_TTL_MS)
                : (this.options.ttlMs ?? PREVIEW_TTL_MS);
        if (this.now() - entry.fetchedAt >= ttl) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.preview;
    }

    private start(
        key: string,
        terminalId: string,
        request: TerminalReferencePreviewRequest,
    ): InFlightPreview {
        const controller = new AbortController();
        const read = async (): Promise<TerminalReferencePreview> => {
            try {
                const preview = await this.requestPreview(terminalId, request, controller.signal);
                rememberBounded(
                    this.entries,
                    key,
                    { fetchedAt: this.now(), preview },
                    this.options.maxEntries ?? MAX_PREVIEW_ENTRIES,
                );
                return preview;
            } finally {
                /**
                 * A rejection is the Server saying it could not answer, including the cancellation this store itself
                 * requested when the last hover left. Nothing is remembered in that case, so the next hover asks again.
                 * The identity check keeps a late settlement from evicting a newer read under the same key.
                 */
                if (this.inFlight.get(key)?.controller === controller) this.inFlight.delete(key);
            }
        };
        const flight: InFlightPreview = {
            controller,
            promise: read(),
            waiters: new Set<AbortSignal>(),
        };
        this.inFlight.set(key, flight);
        return flight;
    }

    /**
     * Resolves the preview for one hover, or `undefined` when the hover ended first or the read failed. Never rejects:
     * the caller is a tooltip, and a tooltip has no way to report an error the user did not ask for.
     */
    async load(
        terminalId: string,
        request: TerminalReferencePreviewRequest,
        signal: AbortSignal,
    ): Promise<TerminalReferencePreview | undefined> {
        const key = terminalReferencePreviewKey(terminalId, request);
        const cached = this.cached(key);
        if (cached) return cached;
        if (signal.aborted) return undefined;
        const flight = this.inFlight.get(key) ?? this.start(key, terminalId, request);
        flight.waiters.add(signal);
        let leave = (): void => {};
        /**
         * Raced against the read so a hover that ends is answered immediately. Waiting for the Server to come back
         * first would hold a card nobody can see, and would let a slow read reorder itself in front of the next hover.
         */
        const departure = new Promise<undefined>((resolve) => {
            leave = () => {
                flight.waiters.delete(signal);
                if (flight.waiters.size === 0) flight.controller.abort();
                resolve(undefined);
            };
        });
        signal.addEventListener('abort', leave, { once: true });
        try {
            return await Promise.race([flight.promise, departure]);
        } catch {
            return undefined;
        } finally {
            signal.removeEventListener('abort', leave);
            leave();
        }
    }

    clear(): void {
        this.entries.clear();
        for (const flight of this.inFlight.values()) flight.controller.abort();
        this.inFlight.clear();
    }
}
