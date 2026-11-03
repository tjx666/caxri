/**
 * Subagent transcripts for the fake Claude Code CLI's background-work scenarios, written where and how Claude Code
 * writes them, so Server Core rebuilds and prices them like real ones.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FakeClaudeIo } from './fake-claude-io.ts';

type Json = Record<string, unknown>;

/**
 * The model a subagent transcript records. A priced model, unlike the `fake-haiku` alias the tool call asks for, so the
 * task tab shows a cost.
 */
export const SUBAGENT_MODEL = 'claude-haiku-4-5';
const SUBAGENT_RESPONSE_USAGE = {
    input_tokens: 4,
    output_tokens: 300,
    cache_read_input_tokens: 20_000,
    cache_creation_input_tokens: 2_000,
};

/**
 * Writes a subagent transcript the way Claude Code does, beside the session transcript (or, for a workflow member, in
 * its run's folder).
 */
export function recordSubagent(
    io: FakeClaudeIo,
    agentId: string,
    meta: Json,
    messages: Json[],
    directory = io.subagentDirectory,
) {
    fs.mkdirSync(directory, { recursive: true });
    const base = path.join(directory, `agent-${agentId}`);
    fs.writeFileSync(`${base}.meta.json`, JSON.stringify(meta));
    let parentUuid: string | null = null;
    const timestamp = new Date().toISOString();
    const lines = messages.map((record) => {
        const uuid = crypto.randomUUID();
        const type = typeof record.type === 'string' ? record.type : record.role;
        const line = JSON.stringify({
            parentUuid,
            isSidechain: true,
            agentId,
            uuid,
            timestamp,
            type,
            ...('local_command_run' in record && {
                local_command_run: record.local_command_run,
            }),
            ...('local_command_source' in record && {
                local_command_source: record.local_command_source,
            }),
            ...(type === 'system'
                ? record
                : {
                      // Billed like a real subagent response, so the task tab can price the subagent from this file. A
                      // mod's output is recorded as an assistant entry but is no model response, so it bills nothing.
                      message:
                          type === 'assistant' && !('local_command_run' in record)
                              ? {
                                    ...record,
                                    model: SUBAGENT_MODEL,
                                    usage: SUBAGENT_RESPONSE_USAGE,
                                }
                              : record,
                  }),
        });
        parentUuid = uuid;
        return line;
    });
    fs.writeFileSync(`${base}.jsonl`, `${lines.join('\n')}\n`);
}
