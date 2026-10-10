import { Buffer } from 'node:buffer';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { claudeTranscriptRoot, resolveClaudeConfigDirectory } from '../agents';
import { isRecord } from './chat-items';

/**
 * Claude Code writes each subagent's conversation beside the session transcript: `<config>/projects/<project
 * key>/<session id>/subagents/agent-<agent id>.jsonl`, with an `agent-<agent id>.meta.json` naming the parent
 * `toolUseId`, `agentType`, and `description`. The path is derived from the Chat's own cwd and session; a
 * Client-supplied id is only ever compared against the metadata, never joined into a path.
 */

const SUBAGENT_META = /^agent-[\w-]{1,200}\.meta\.json$/u;

const SESSION_ID = /^[\w-]{1,200}$/u;

/**
 * Metadata files read per lookup, so a session with a huge subagent directory cannot stall the request.
 */
const MAX_SUBAGENT_METAS = 1_000;

const MAX_META_BYTES = 64 * 1024;

/**
 * Tail of a subagent transcript read for its tab; the task projection keeps far less than this anyway.
 */
const MAX_SUBAGENT_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

export interface ClaudeSubagentTranscript {
    toolUseId: string;
    content: string;
    truncated: boolean;
}

async function readMetaToolUseId(path: string): Promise<string | undefined> {
    try {
        const stats = await lstat(path);
        if (!stats.isFile() || stats.size > MAX_META_BYTES) return undefined;
        const meta: unknown = JSON.parse(await readFile(path, 'utf8'));
        return isRecord(meta) && typeof meta.toolUseId === 'string' ? meta.toolUseId : undefined;
    } catch {
        return undefined;
    }
}

async function readTail(
    path: string,
): Promise<{ content: string; truncated: boolean } | undefined> {
    const stats = await lstat(path);
    if (!stats.isFile()) return undefined;
    const handle = await open(path, 'r');
    try {
        const isTruncated = stats.size > MAX_SUBAGENT_TRANSCRIPT_BYTES;
        const length = isTruncated ? MAX_SUBAGENT_TRANSCRIPT_BYTES : stats.size;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, stats.size - length);
        let content = buffer.subarray(0, bytesRead).toString('utf8');
        // A tail read starts mid-record; drop the partial first line.
        if (isTruncated) content = content.slice(content.indexOf('\n') + 1);
        return { content, truncated: isTruncated };
    } finally {
        await handle.close();
    }
}

/**
 * Finds and reads the transcript of the subagent the parent tool call `toolUseId` started. Resolves `undefined` when
 * Claude Code recorded no such subagent or its files cannot be read.
 */
export async function readClaudeSubagentTranscript(options: {
    environment: NodeJS.ProcessEnv;
    cwd: string;
    sessionId: string;
    toolUseId: string;
}): Promise<ClaudeSubagentTranscript | undefined> {
    const { environment, cwd, sessionId, toolUseId } = options;
    if (!SESSION_ID.test(sessionId)) return undefined;
    const configDirectory = resolveClaudeConfigDirectory({
        homeDirectory: environment.HOME ?? homedir(),
        variables: environment,
    });
    const directory = join(claudeTranscriptRoot(configDirectory, cwd), sessionId, 'subagents');
    let names: string[];
    try {
        names = await readdir(directory);
    } catch {
        return undefined;
    }
    const metas = names.filter((name) => SUBAGENT_META.test(name)).slice(0, MAX_SUBAGENT_METAS);
    const owners = await Promise.all(
        metas.map(async (name) => ({
            name,
            owner: await readMetaToolUseId(join(directory, name)),
        })),
    );
    const match = owners.find((entry) => entry.owner === toolUseId);
    if (!match) return undefined;
    try {
        const tail = await readTail(
            join(directory, match.name.replace(/\.meta\.json$/u, '.jsonl')),
        );
        return tail && { toolUseId, ...tail };
    } catch {
        return undefined;
    }
}
