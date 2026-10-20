import type { BenchmarkJudgeScore } from '@caxri/protocol';
import { z } from 'zod';

const MAX_JUDGED_ANSWER_LENGTH = 8_000;
const MAX_JUDGED_DIFF_LENGTH = 16_000;
const MAX_JUDGED_TASK_LENGTH = 20_000;
/**
 * Total character budget for one judge prompt. Per-candidate limits alone let 120 candidates reach about 2.9 MB, past
 * the judge model's context; this keeps the whole prompt bounded however many candidates a run has.
 */
export const MAX_JUDGE_PROMPT_LENGTH = 400_000;
/**
 * Characters a candidate costs beyond its answer and diff: headings, the diff fence, and two truncation markers.
 */
const CANDIDATE_OVERHEAD = 160;
/**
 * Slack for the fixed instructions and section separators around the candidates.
 */
const PROMPT_FRAME_OVERHEAD = 1_500;

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
    const taskText = clip(task, MAX_JUDGED_TASK_LENGTH);
    // Candidates share the budget equally; room a short answer does not use goes to its diff.
    const share = Math.floor(
        (MAX_JUDGE_PROMPT_LENGTH - PROMPT_FRAME_OVERHEAD - taskText.length) /
            Math.max(shuffled.length, 1),
    );
    const available = Math.max(share - CANDIDATE_OVERHEAD, 0);
    const sections = shuffled.map((candidate, index) => {
        const label = labelFor(index);
        const answer = candidate.finalText?.trim();
        labels.set(candidate.attemptId, label);
        const answerLimit = Math.min(
            MAX_JUDGED_ANSWER_LENGTH,
            Math.ceil(available / 2),
            answer?.length ?? 0,
        );
        const diffLimit = Math.min(MAX_JUDGED_DIFF_LENGTH, available - answerLimit);
        return [
            `## Candidate ${label}`,
            '### Final answer',
            answer ? clip(answer, answerLimit) : '(no answer)',
            '### Changes made',
            candidate.diff?.trim()
                ? `\`\`\`diff\n${clip(candidate.diff.trim(), diffLimit)}\n\`\`\``
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
        taskText,
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
