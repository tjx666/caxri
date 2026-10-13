import type { ProjectStatusCodexReview } from '@caxri/protocol';

/**
 * The hidden marker opening the review summary comment Codex's GitHub integration keeps on a pull request. Codex edits
 * that one comment as reviews start and finish, so its table is the only record of a review that found nothing to
 * comment on.
 */
const CODEX_REVIEW_SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';

const SEPARATOR_CELL = /^:?-{3,}:?$/u;
const BOLD = /\*\*([^*]+)\*\*/u;
const DATETIME = /datetime="([^"]+)"/u;
const SHORT_SHA = /`([0-9a-f]{7,40})`/u;

function cellsOf(line: string): string[] | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined;
    return trimmed
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim());
}

/**
 * A cell's words without the emoji, Markdown emphasis, code ticks, or HTML Codex decorates it with.
 */
function plainText(cell: string): string {
    return cell
        .replaceAll(/<([a-z-]+)(?:\s[^>]*)?>[^<]*<\/\1>/giu, '')
        .replaceAll(/<[^>]*>/gu, '')
        .replaceAll(/\*\*|`/gu, '')
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .trim();
}

/**
 * Codex writes `Completed` today; the other words are the ones a review lifecycle can plausibly report, matched loosely
 * so a reworded status still lands in the right state instead of reading as finished.
 */
function reviewState(status: string): ProjectStatusCodexReview['state'] {
    const word = status.toLowerCase();
    if (/fail|error|cancel|timed out|abort/u.test(word)) return 'failed';
    if (/progress|running|queued|pending|started|reviewing|requested/u.test(word)) return 'running';
    if (/complete|done|finished|succeeded/u.test(word)) return 'completed';
    return 'unknown';
}

/**
 * The rows of a Codex review summary comment, or an empty list for any other comment. A row Caxri cannot read keeps its
 * status word with an `unknown` state rather than disappearing, so a changed format shows up as unclassified.
 */
export function parseCodexReviewSummary(body: string, url: string): ProjectStatusCodexReview[] {
    if (!body.includes(CODEX_REVIEW_SUMMARY_MARKER)) return [];
    const reviews: ProjectStatusCodexReview[] = [];
    for (const line of body.split('\n')) {
        const cells = cellsOf(line);
        if (!cells || cells.length < 2) continue;
        const [nameCell = '', statusCell = '', commitCell = '', triggerCell = ''] = cells;
        if (SEPARATOR_CELL.test(nameCell)) continue;
        const name = plainText(nameCell);
        const status = BOLD.exec(statusCell)?.[1]?.trim() ?? plainText(statusCell);
        // The header row names its columns; Codex's own header is `| Review | Status | Commit | Review trigger |`.
        if (!name || !status || (name === 'Review' && status === 'Status')) continue;
        const datetime = DATETIME.exec(statusCell)?.[1];
        const updatedAt = datetime ? Date.parse(datetime) : NaN;
        const commit = SHORT_SHA.exec(commitCell)?.[1];
        const trigger = plainText(triggerCell);
        reviews.push({
            name,
            status,
            state: reviewState(status),
            ...(commit && { commit }),
            ...(trigger && { trigger }),
            ...(Number.isFinite(updatedAt) && { updatedAt }),
            url,
        });
    }
    return reviews;
}
