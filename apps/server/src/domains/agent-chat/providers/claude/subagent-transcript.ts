import { Buffer } from 'node:buffer';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentChatTask } from '@caxri/protocol';
import { findAgentChatTask, parseAgentChatWorkflowMemberTaskId } from '@caxri/protocol';
import { readBoundedRegularFileText } from '@caxri/system';

import {
    claudeTranscriptRoot,
    readClaudeSubagentToolUseId,
    resolveClaudeConfigDirectory,
} from '../../../agents';
import { clip } from '../../chat-items';
import type { AgentChatSessionHost, ChatTaskHistory } from '../../chat-provider';
import { claudeTaskHistoryOperations } from '../../history/claude-history';
import {
    claudeWorkflowRunIdFromText,
    isClaudeWorkflowRunId,
    parseClaudeWorkflowRecord,
} from './workflow';

/**
 * Claude Code writes each subagent's conversation beside the session transcript: `<config>/projects/<project
 * key>/<session id>/subagents/agent-<agent id>.jsonl`, with an `agent-<agent id>.meta.json` naming the parent
 * `toolUseId`, `agentType`, and `description`. A workflow run's members write theirs under `subagents/workflows/<run
 * id>/agent-<agent id>.jsonl`, and the run itself leaves `<session>/workflows/<run id>.json`. The path is derived from
 * the Chat's own cwd and session; a Client-supplied subagent id is only ever compared against the metadata, and a
 * workflow member's run and agent ids are joined only after matching `[\w-]` patterns.
 */

const SUBAGENT_META = /^agent-[\w-]{1,200}\.meta\.json$/u;

const SESSION_ID = /^[\w-]{1,200}$/u;

/**
 * Metadata files read per lookup, so a session with a huge subagent directory cannot stall the request.
 */
const MAX_SUBAGENT_METAS = 1_000;

/**
 * Tail of a subagent transcript read for its tab; the task projection keeps far less than this anyway.
 */
const MAX_SUBAGENT_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

/**
 * A run record holds the run's script and every member's progress; far below this in practice.
 */
const MAX_WORKFLOW_RECORD_BYTES = 8 * 1024 * 1024;

interface ClaudeSubagentTranscript {
    toolUseId: string;
    content: string;
    truncated: boolean;
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

function sessionDirectory(environment: NodeJS.ProcessEnv, cwd: string, sessionId: string): string {
    const configDirectory = resolveClaudeConfigDirectory({
        homeDirectory: environment.HOME ?? homedir(),
        variables: environment,
    });
    return join(claudeTranscriptRoot(configDirectory, cwd), sessionId);
}

/**
 * Finds and reads the transcript of the subagent the parent tool call `toolUseId` started. Resolves `undefined` when
 * Claude Code recorded no such subagent or its files cannot be read.
 */
async function readClaudeSubagentTranscript(options: {
    environment: NodeJS.ProcessEnv;
    cwd: string;
    sessionId: string;
    toolUseId: string;
}): Promise<ClaudeSubagentTranscript | undefined> {
    const { environment, cwd, sessionId, toolUseId } = options;
    if (!SESSION_ID.test(sessionId)) return undefined;
    const directory = join(sessionDirectory(environment, cwd, sessionId), 'subagents');
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
            owner: await readClaudeSubagentToolUseId(join(directory, name)),
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

interface ClaudeTaskLocation {
    environment: NodeJS.ProcessEnv;
    cwd: string;
    sessionId: string;
}

/**
 * A workflow member's own conversation, read on every request: Claude Code streams no member frames to the Chat, so its
 * transcript is the only live view of a running member.
 */
async function readWorkflowMember(
    location: ClaudeTaskLocation,
    taskId: string,
): Promise<ChatTaskHistory | undefined> {
    const member = parseAgentChatWorkflowMemberTaskId(taskId);
    if (!member || !SESSION_ID.test(location.sessionId)) return undefined;
    const path = join(
        sessionDirectory(location.environment, location.cwd, location.sessionId),
        'subagents',
        'workflows',
        member.runId,
        `agent-${member.agentId}.jsonl`,
    );
    try {
        const tail = await readTail(path);
        return (
            tail && {
                taskId,
                operations: claudeTaskHistoryOperations(tail.content, tail.truncated),
                isLive: true,
            }
        );
    } catch {
        return undefined;
    }
}

/**
 * A workflow run rebuilt from its run record. `status` is the live task's (undefined once the Chat no longer lists the
 * run), so a record that never ended is not mistaken for an interrupted run while the run still runs. Read on every
 * request (`isLive`): the record appears only as the run ends, so a projection installed while it ran would never show
 * the run's result.
 */
async function readWorkflowRun(
    location: ClaudeTaskLocation,
    taskId: string,
    runId: string,
    status: AgentChatTask['status'] | undefined,
): Promise<ChatTaskHistory | undefined> {
    if (!isClaudeWorkflowRunId(runId) || !SESSION_ID.test(location.sessionId)) return undefined;
    const path = join(
        sessionDirectory(location.environment, location.cwd, location.sessionId),
        'workflows',
        `${runId}.json`,
    );
    let raw: unknown;
    try {
        raw = JSON.parse(
            await readBoundedRegularFileText(path, MAX_WORKFLOW_RECORD_BYTES, {
                symlinks: 'nofollow',
            }),
        );
    } catch {
        // A running workflow writes its record only as it ends, and a stopped one may write none; while the Chat still
        // lists the run, its tab shows the live task instead.
        return status === undefined
            ? undefined
            : { taskId, operations: [{ op: 'reset' }], isLive: true };
    }
    const record = parseClaudeWorkflowRecord(raw, runId);
    const isInterrupted = record.status === undefined && status !== 'running';
    const workflow = isInterrupted
        ? {
              ...record.workflow,
              isInterrupted,
              members: record.workflow.members.map((entry) =>
                  entry.status === 'running' || entry.status === 'queued'
                      ? { ...entry, status: 'stopped' as const }
                      : entry,
              ),
          }
        : record.workflow;
    return {
        taskId,
        operations: [{ op: 'reset' }, { op: 'state', state: { workflow } }],
        isLive: true,
    };
}

/**
 * Rebuilds a subagent the Chat never streamed (an earlier process, a resumed conversation) from the transcript Claude
 * Code wrote for it, a workflow member from its own transcript, and a workflow run from its run record. A background
 * shell keeps no record once its process is gone.
 */
export async function readClaudeTaskHistory(
    chat: Pick<AgentChatSessionHost, 'cwd' | 'environment' | 'read'>,
    sessionId: string,
    requestedId: string,
): Promise<ChatTaskHistory | undefined> {
    const location: ClaudeTaskLocation = {
        environment: chat.environment,
        cwd: chat.cwd,
        sessionId,
    };
    // A workflow run is found by the run id its live task or its `Workflow` row's tool result names, and a live task is
    // read under its own id.
    const snapshot = chat.read();
    const task = findAgentChatTask(snapshot.tasks, requestedId);
    const taskId = task?.id ?? requestedId;
    if (parseAgentChatWorkflowMemberTaskId(taskId)) return readWorkflowMember(location, taskId);
    const row = snapshot.items.find((item) => item.id === (task?.itemId ?? taskId));
    const workflowRunId =
        task?.workflow?.runId ??
        (row?.type === 'toolCall' && row.name === 'Workflow'
            ? claudeWorkflowRunIdFromText(row.output)
            : undefined);
    if (workflowRunId) return readWorkflowRun(location, taskId, workflowRunId, task?.status);
    const transcript = await readClaudeSubagentTranscript({ ...location, toolUseId: taskId });
    if (!transcript) return undefined;
    return {
        taskId: clip(transcript.toolUseId, 200),
        operations: claudeTaskHistoryOperations(transcript.content, transcript.truncated),
    };
}
