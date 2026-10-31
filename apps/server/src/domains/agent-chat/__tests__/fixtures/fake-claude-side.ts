/**
 * Side questions for the fake Claude Code CLI (`fake-claude-cli.ts`): the `side_question` control request behind
 * `/btw`. It answers at once, even while a turn streams, quoting the question and how many earlier exchanges came with
 * it, and appends each request to `side-questions.jsonl` in the config directory so tests can check what Caxri sent. A
 * question containing `side-null` is answered with no response, as the CLI does when the model returns nothing, and one
 * containing `side-error` is refused. While a `hold-side-question` file exists under `FAKE_CLAUDE_CONTROL_DIR`, a side
 * question waits for its removal, so a test can see what the Client shows while the answer is pending.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

type Json = Record<string, unknown>;

export function answerSideQuestion(
    request: Json,
    configDirectory: string,
): { response?: Json; error?: string } {
    const question = request.question;
    const history = request.history;
    fs.appendFileSync(
        path.join(configDirectory, 'side-questions.jsonl'),
        `${JSON.stringify({ question, history })}\n`,
    );
    if (typeof question !== 'string' || (history !== undefined && !Array.isArray(history)))
        return {
            error: 'side_question: question must be a string and history an array of {question, response} strings',
        };
    if (question.includes('side-error')) return { error: 'side_question failed' };
    if (question.includes('side-null')) return { response: { response: null } };
    return {
        response: {
            response: `Side answer to "${question}" after ${history?.length ?? 0} earlier`,
            synthetic: false,
        },
    };
}

/**
 * Whether `request` is a side question held by the `hold-side-question` control file; `replay` handles it again once
 * the file is removed.
 */
export function didHoldSideQuestion(request: Json, replay: () => void): boolean {
    const controlDirectory = process.env.FAKE_CLAUDE_CONTROL_DIR;
    const isHeld = () =>
        controlDirectory !== undefined &&
        fs.existsSync(path.join(controlDirectory, 'hold-side-question'));
    if (request.subtype !== 'side_question' || !isHeld()) return false;
    const timer = setInterval(() => {
        if (isHeld()) return;
        clearInterval(timer);
        replay();
    }, 100);
    return true;
}
