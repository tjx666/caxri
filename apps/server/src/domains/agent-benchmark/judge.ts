import type { BenchmarkJudgeScore } from '@caxri/protocol';
import { z } from 'zod';

const MAX_JUDGED_ANSWER_LENGTH = 8_000;
const MAX_JUDGED_DIFF_LENGTH = 16_000;

export interface JudgeCandidate {
    attemptId: string;
    finalText?: string;
    diff?: string;
}

export interface JudgePrompt {
    prompt: string;
    /**
     * The anonymous label each Attempt was shown under.
     */
    labels: Map<string, string>;
}

/**
 * Builds the blind judging prompt: every finished Attempt appears under a letter in a shuffled order, without its
 * Agent, model, effort, cost, or time, so the judge scores only what was produced.
 */
export function buildJudgePrompt(
    task: string,
    candidates: readonly JudgeCandidate[],
    random: () => number = Math.random,
): JudgePrompt {
    const shuffled = [...candidates];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        const current = shuffled[index];
        shuffled[index] = shuffled[swap];
        shuffled[swap] = current;
    }
    const labels = new Map<string, string>();
    const sections = shuffled.map((candidate, index) => {
        const label = labelFor(index);
        const answer = candidate.finalText?.trim();
        labels.set(candidate.attemptId, label);
        return [
            `## Candidate ${label}`,
            '### Final answer',
            answer ? clip(answer, MAX_JUDGED_ANSWER_LENGTH) : '(no answer)',
            '### Changes made',
            candidate.diff?.trim()
                ? `\`\`\`diff\n${clip(candidate.diff, MAX_JUDGED_DIFF_LENGTH)}\n\`\`\``
                : '(no file changes)',
        ].join('\n\n');
    });
    const prompt = [
        'You are judging several independent attempts at the same task. Do not run tools, do not edit files, and do not',
        'ask questions. Read the task and each candidate, then score how well each candidate accomplished the task, from',
        '0 (did not address it) to 100 (complete and correct). Judge correctness first, then completeness, then quality.',
        'Score candidates independently; ties are allowed.',
        '',
        'Reply with only this JSON object and nothing else:',
        '{"scores":[{"label":"A","score":0,"reason":"one sentence"}]}',
        '',
        '# Task',
        '',
        task,
        '',
        '# Candidates',
        '',
        sections.join('\n\n'),
    ].join('\n');
    return { prompt, labels };
}

const judgeScoreSchema = z.object({
    label: z.string().min(1).max(4),
    score: z.coerce.number().min(0).max(100),
    reason: z.string().max(5_000).optional(),
});

const judgeReplySchema = z.object({ scores: z.array(judgeScoreSchema).max(200) });

/**
 * Reads the judge's scores by label, or `undefined` when the reply holds no valid score object. Tolerates prose or a
 * code fence around the JSON, since models add them despite instructions.
 */
export function parseJudgeReply(reply: string): Map<string, BenchmarkJudgeScore> | undefined {
    const start = reply.indexOf('{');
    const end = reply.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(reply.slice(start, end + 1));
    } catch {
        return undefined;
    }
    const result = judgeReplySchema.safeParse(parsed);
    if (!result.success) return undefined;
    const scores = new Map<string, BenchmarkJudgeScore>();
    for (const { label, score, reason } of result.data.scores)
        scores.set(label.trim().toUpperCase(), {
            score: Math.round(score),
            reason: (reason ?? '').slice(0, 2_000),
        });
    return scores.size > 0 ? scores : undefined;
}

/**
 * `A` through `Z`, then `AA`, `AB`, ... for runs with more than 26 finished Attempts.
 */
function labelFor(index: number): string {
    const letter = String.fromCodePoint(65 + (index % 26));
    return index < 26
        ? letter
        : `${String.fromCodePoint(65 + Math.floor(index / 26) - 1)}${letter}`;
}

function clip(text: string, limit: number): string {
    return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}
