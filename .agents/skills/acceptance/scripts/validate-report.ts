import { z } from 'zod';

const CHINESE_TEXT = /[\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}]/u;
const CHINESE_CHARACTERS = /[\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}]/gu;
const LATIN_TEXT = /[A-Za-z]/u;
const LATIN_CHARACTERS = /[A-Z]/gi;

function isPrimarilyChinese(value: string): boolean {
    const chineseCount = value.match(CHINESE_CHARACTERS)?.length ?? 0;
    const latinCount = value.match(LATIN_CHARACTERS)?.length ?? 0;
    if (!CHINESE_TEXT.test(value)) return false;
    if (latinCount === 0) return true;
    return chineseCount / (chineseCount + latinCount) >= 0.2;
}

function withoutHtmlComments(value: string): string {
    return value.replaceAll(/<!--[\s\S]*?-->/g, (comment) => comment.replaceAll(/[^\n]/g, ' '));
}

function visibleMarkdownProse(line: string): string {
    return line
        .replaceAll(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replaceAll(/<[^>]+>/g, '')
        .replaceAll(/https?:\/\/\S+/g, '')
        .replaceAll(/`[^`]+`/g, '')
        .trim();
}

const humanTextSchema = z
    .string()
    .trim()
    .min(1)
    .refine(isPrimarilyChinese, 'must be primarily Chinese');

const reportLanguageSchema = z.object({
    cases: z.array(
        z.object({
            category: humanTextSchema,
            name: humanTextSchema,
            observation: humanTextSchema,
        }),
    ),
    entry: humanTextSchema,
    plan: z.array(
        z.object({
            category: humanTextSchema,
            expected: humanTextSchema,
            method: humanTextSchema,
            title: humanTextSchema,
        }),
    ),
    summary: z.object({ conclusion: humanTextSchema }),
    title: humanTextSchema,
});

export function validateHumanText(value: unknown, field: string): string {
    const parsed = humanTextSchema.safeParse(value);
    if (!parsed.success) throw new Error(`${field} must be primarily Chinese`);
    return parsed.data;
}

const comparisonEvidenceCaseSchema = z.object({ evidence: z.array(z.unknown()).optional() });
const comparisonLabelReportSchema = z.object({ cases: z.array(comparisonEvidenceCaseSchema) });

/**
 * The evidence description is what a reviewer reads next to the artifact, so it follows the same language contract as
 * the rest of the human-facing report rather than falling back to an English filename.
 */
function validateEvidenceDescription(evidence: unknown, field: string): void {
    if (typeof evidence !== 'object' || evidence === null || !('description' in evidence)) return;
    validateHumanText(evidence.description, field);
}

function validateComparisonLabel(evidence: unknown, field: string): void {
    if (
        typeof evidence !== 'object' ||
        evidence === null ||
        !('comparison' in evidence) ||
        typeof evidence.comparison !== 'object' ||
        evidence.comparison === null
    ) {
        return;
    }
    const label = 'label' in evidence.comparison ? evidence.comparison.label : undefined;
    validateHumanText(label, field);
}

function validateEvidenceProse(report: unknown): void {
    const parsed = comparisonLabelReportSchema.safeParse(report);
    if (!parsed.success) return;
    for (const [caseIndex, item] of parsed.data.cases.entries()) {
        const evidenceList = item.evidence ?? [];
        for (const [evidenceIndex, evidence] of evidenceList.entries()) {
            validateComparisonLabel(
                evidence,
                `cases.${caseIndex}.evidence.${evidenceIndex}.comparison.label`,
            );
            validateEvidenceDescription(
                evidence,
                `cases.${caseIndex}.evidence.${evidenceIndex}.description`,
            );
        }
    }
}

function validateMarkdownProse(document: string | undefined, file: string): void {
    let isInsideFence = false;
    const lines = withoutHtmlComments(document ?? '').split('\n');
    for (const [index, rawLine] of lines.entries()) {
        if (/^\s*(?:```|~~~)/.test(rawLine)) {
            isInsideFence = !isInsideFence;
            continue;
        }
        if (isInsideFence) continue;
        const line = visibleMarkdownProse(rawLine);
        if (!CHINESE_TEXT.test(line) && !LATIN_TEXT.test(line)) continue;
        if (!humanTextSchema.safeParse(line).success) {
            throw new Error(`${file} line ${index + 1} must be primarily Chinese`);
        }
    }
}

export function validateReportLanguage({
    notes,
    proposal,
    report,
    requirement,
}: {
    notes?: string;
    proposal?: string;
    report: unknown;
    requirement: string;
}): void {
    validateHumanText(requirement, 'requirement');
    const parsedReport = reportLanguageSchema.safeParse(report);
    if (!parsedReport.success) {
        const issue = parsedReport.error.issues[0];
        // Zod types `issues` as a plain array without encoding the "non-empty on failure"
        // invariant, so `issue` can be `undefined` at the type level even though it never is here.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
        const field = issue?.path.length ? issue.path.join('.') : 'report';
        throw new Error(`${field} must be primarily Chinese`);
    }
    validateEvidenceProse(report);
    validateMarkdownProse(notes, 'report.md');
    validateMarkdownProse(proposal, 'proposal.md');
}
