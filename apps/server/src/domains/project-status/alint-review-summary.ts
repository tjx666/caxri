import type { ProjectStatusReviewThread } from '@caxri/protocol';

/**
 * The hidden marker opening the summary ALint (a model-backed lint run in GitHub Actions) keeps on a pull request. It
 * rewrites that one review body (an issue comment in its older shape) on every push, with one table row per finding.
 *
 * @see https://github.com/lobehub/lobehub/blob/canary/packages/alint/report.ts
 */
const ALINT_SUMMARY_MARKER = '<!-- alint-summary -->';
/**
 * The marker ALint puts on the inline comment it posts for a finding. Its key is `file:line` (with a `:rule` or `#n`
 * suffix when several findings share a line) or a bare `file` when the file's findings were aggregated into one
 * comment.
 */
const ALINT_FINDING_MARKER = /<!-- alint-finding:(.+?) -->/gu;

/**
 * `[`path/to/file.ts:42`](https://github.com/...)`, the Location cell.
 */
const LOCATION = /\[`([^`]+):(\d+)`\]\(([^)\s]+)\)/u;
const RULE = /`([^`]+)`/u;
/**
 * ALint appends a finding's suggested fix as `<br><sub>💡 …</sub>`.
 */
const SUGGESTION_OPEN = '<br><sub>💡';
const SUGGESTION_CLOSE = '</sub>';

/**
 * A Finding cell split into its message and its suggested fix.
 */
function splitFinding(detail: string): { message: string; suggestion?: string } {
    const open = detail.indexOf(SUGGESTION_OPEN);
    if (open === -1) return { message: detail.trim() };
    const rest = detail.slice(open + SUGGESTION_OPEN.length);
    const close = rest.lastIndexOf(SUGGESTION_CLOSE);
    const suggestion = (close === -1 ? rest : rest.slice(0, close)).trim();
    return { message: detail.slice(0, open).trim(), ...(suggestion && { suggestion }) };
}

/**
 * A table row's cells, splitting on `|` but not on the `\|` ALint escapes inside a finding's text.
 */
function cellsOf(line: string): string[] | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined;
    return trimmed
        .slice(1, -1)
        .split(/(?<!\\)\|/u)
        .map((cell) => cell.trim().replaceAll(String.raw`\|`, '|'));
}

export function isAlintSummary(body: string): boolean {
    return body.includes(ALINT_SUMMARY_MARKER);
}

/**
 * The inline-comment keys ALint already posted, so a finding it commented on is not listed a second time.
 */
export function alintFindingKeys(bodies: Iterable<string>): Set<string> {
    const keys = new Set<string>();
    for (const body of bodies) {
        for (const match of body.matchAll(ALINT_FINDING_MARKER)) keys.add(match[1]);
    }
    return keys;
}

function isCoveredByInlineComment(keys: ReadonlySet<string>, path: string, line: number): boolean {
    if (keys.has(path)) return true;
    const prefix = `${path}:${line}`;
    for (const key of keys) {
        if (key === prefix || key.startsWith(`${prefix}:`) || key.startsWith(`${prefix}#`))
            return true;
    }
    return false;
}

/**
 * ALint's findings as review rows, or an empty list for any other body. ALint comments inline only on lines inside the
 * pull request's diff, so a finding elsewhere exists nowhere but this table; without reading it the Status panel said
 * `No comments` on a pull request ALint had flagged. A finding ALint also commented inline is skipped (`inlineKeys`):
 * that comment is already a review thread, and resolving it must not leave a copy behind.
 */
export function parseAlintReviewSummary(
    body: string,
    source: { url: string; author?: string },
    inlineKeys: ReadonlySet<string>,
): ProjectStatusReviewThread[] {
    if (!isAlintSummary(body)) return [];
    const findings: ProjectStatusReviewThread[] = [];
    for (const line of body.split('\n')) {
        const cells = cellsOf(line);
        if (!cells || cells.length < 4) continue;
        const [severityCell = '', locationCell = '', ruleCell = '', ...findingCells] = cells;
        const location = LOCATION.exec(locationCell);
        if (!location) continue;
        const [, path = '', lineText = '', link = ''] = location;
        const lineNumber = Number(lineText);
        if (lineNumber > 0 && isCoveredByInlineComment(inlineKeys, path, lineNumber)) continue;
        const rule = RULE.exec(ruleCell)?.[1] ?? ruleCell;
        const { message, suggestion } = splitFinding(findingCells.join(' | '));
        const severity = severityCell.includes('❌') ? 'error' : 'warning';
        findings.push({
            // The row opens the summary on the pull request, where the finding reads in context; the body links the code.
            url: source.url,
            body: [
                `**ALint** \`${rule}\` (${severity}): ${message}`,
                ...(suggestion ? ['', `💡 ${suggestion}`] : []),
                '',
                `Location: ${link}`,
            ].join('\n'),
            ...(source.author && { author: source.author }),
            path,
            ...(lineNumber > 0 && { line: lineNumber }),
        });
    }
    return findings;
}
