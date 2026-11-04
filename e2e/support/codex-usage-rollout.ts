import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A content-free Codex rollout in the isolated E2E `CODEX_HOME` (`<profile>/e2e-agents/codex`), carrying only the
 * counters the Usage ledger reads. The Server's own ledger scan turns it into the thread's usage, exactly as for a real
 * Codex run, so a spec can give a running fake Chat a cost without seeding a ledger row.
 */
export async function writeCodexUsageRollout(
    userDataDirectory: string,
    options: {
        /**
         * The working directory recorded in the rollout; a thread bound to a Terminal takes its Session from the
         * binding, not from this.
         */
        cwd: string;
        inputTokens: number;
        /**
         * `gpt-5` has a list price; an unpriced name makes the thread's cost a lower bound.
         */
        model?: string;
        outputTokens: number;
        threadId: string;
    },
): Promise<void> {
    // Caxri finds a rollout by the day its thread id (a UUIDv7) encodes, so the file lives in that day's folder.
    const created = new Date(
        Number.parseInt(options.threadId.replaceAll('-', '').slice(0, 12), 16),
    );
    const pad = (value: number) => String(value).padStart(2, '0');
    const day = join(
        userDataDirectory,
        'e2e-agents',
        'codex',
        'sessions',
        String(created.getFullYear()),
        pad(created.getMonth() + 1),
        pad(created.getDate()),
    );
    await mkdir(day, { recursive: true });
    // The same name a fake Codex gives the thread's own rollout, so the two are one file rather than two candidates.
    const clock = `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}T${pad(created.getHours())}-${pad(created.getMinutes())}-${pad(created.getSeconds())}`;
    const timestamp = new Date().toISOString();
    const records = [
        {
            timestamp,
            type: 'session_meta',
            payload: { id: options.threadId, cwd: options.cwd },
        },
        { timestamp, type: 'turn_context', payload: { model: options.model ?? 'gpt-5' } },
        {
            timestamp,
            type: 'event_msg',
            payload: {
                type: 'token_count',
                info: {
                    total_token_usage: {
                        input_tokens: options.inputTokens,
                        output_tokens: options.outputTokens,
                    },
                },
            },
        },
    ];
    await writeFile(
        join(day, `rollout-${clock}-${options.threadId}.jsonl`),
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
}
