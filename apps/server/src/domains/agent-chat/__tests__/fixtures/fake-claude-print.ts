import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { publishFakeClaudeSessionMetadata } from './fake-claude-metadata.ts';

/**
 * The generated title fake Claude answers a low-cost generation with. English, so it passes the Latin-prompt language
 * check; a prompt asking for Chinese gets {@link FAKE_GENERATED_TITLE_ZH}.
 */
export const FAKE_GENERATED_TITLE = 'Fake generated title';
export const FAKE_GENERATED_TITLE_ZH = '模拟生成的标题';

const RENAME_RESULT_PREFIX = 'Session renamed to:';

/**
 * Spends one use of a counted control file: no file means no injection, an empty file applies forever, and a number
 * applies that many times, the file disappearing with the last use.
 */
function didSpendControl(directory: string | undefined, name: string): boolean {
    if (!directory) return false;
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) return false;
    const text = fs.readFileSync(file, 'utf8').trim();
    const remaining = Number(text);
    if (text === '' || Number.isNaN(remaining)) return true;
    if (remaining <= 1) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, String(remaining - 1));
    return true;
}

/**
 * The answer to a low-cost generation. Naming is opt-in: without an `ai-naming` control file the answer is `SKIP`, so
 * the automatic naming that follows every turn leaves Session titles alone in specs that never asked for it. Other
 * control files steer an opted-in generation, each holding the number of answers it still applies to (empty means every
 * answer): `naming-skip` answers `SKIP` and `naming-invalid` answers a title that fails validation. A Session's opening
 * request and its first completed-turn sample each spend one `SKIP`, so `2` makes the second sample succeed.
 */
function generatedTitle(prompt: string, controlDirectory: string | undefined): string {
    if (!controlDirectory || !fs.existsSync(path.join(controlDirectory, 'ai-naming')))
        return 'SKIP';
    if (didSpendControl(controlDirectory, 'naming-skip')) return 'SKIP';
    if (didSpendControl(controlDirectory, 'naming-invalid')) {
        return 'Title: not a valid generated title';
    }
    return prompt.includes('<title_language>Chinese')
        ? FAKE_GENERATED_TITLE_ZH
        : FAKE_GENERATED_TITLE;
}

async function readStandardInput(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * Answers the one-shot `claude --print` modes Caxri runs outside a Chat, deterministically and without a model, and
 * returns whether it did; any other launch gets its live `sessions/<pid>.json` metadata published instead.
 *
 * - `--resume <id> /rename <title>` appends the `custom-title` record Claude Code writes and reports the JSON result the
 *   provider rename parses.
 * - Any other `--print` is low-cost generation (AI Session naming): the prompt arrives on stdin and the answer is
 *   {@link generatedTitle}.
 */
export async function didRunFakeClaudeOneShot(
    configDirectory: string,
    sessionId: string,
    transcriptPath: string,
    controlDirectory: string | undefined,
): Promise<boolean> {
    const argv = process.argv;
    if (!argv.includes('--print')) {
        publishFakeClaudeSessionMetadata({ configDirectory, cwd: process.cwd(), sessionId });
        return false;
    }
    const lastArgument = argv.at(-1) ?? '';
    if (argv.includes('--resume') && lastArgument.startsWith('/rename ')) {
        const title = lastArgument.slice('/rename '.length);
        fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
        fs.appendFileSync(
            transcriptPath,
            `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })}\n`,
        );
        process.stdout.write(
            `${JSON.stringify({
                type: 'result',
                subtype: 'success',
                is_error: false,
                result: `${RENAME_RESULT_PREFIX} ${title}`,
                session_id: sessionId,
            })}\n`,
        );
        return true;
    }
    process.stdout.write(`${generatedTitle(await readStandardInput(), controlDirectory)}\n`);
    return true;
}
