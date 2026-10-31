/**
 * Thread persistence for the fake Codex app-server (`fake-codex-app-server.ts`). Threads persist to
 * `FAKE_CODEX_STATE_DIR` (or the OS temp directory) so `thread/resume` returns real history. Each thread open also
 * appends its method, sandbox, and approval policy to `thread-opens.jsonl` there, so tests can assert the configuration
 * Caxri asked for.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { FakeInput, FakeThread } from './fake-codex-io.ts';

export function fakeCodexStateDirectory() {
    const directory =
        process.env.FAKE_CODEX_STATE_DIR ?? path.join(os.tmpdir(), 'caxri-fake-codex');
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

export function stateFile(name: string) {
    return path.join(fakeCodexStateDirectory(), name);
}

export function threadPath(id: string, extension = 'json') {
    return stateFile(`${id.replaceAll(/[^\w-]/gu, '_')}.${extension}`);
}

export function saveThread(thread: FakeThread) {
    if (thread.turns.length > 0) fs.writeFileSync(threadPath(thread.id), JSON.stringify(thread));
}

export function readSavedThread(id: string): FakeThread | undefined {
    const file = threadPath(id);
    return fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, 'utf8')) as FakeThread)
        : undefined;
}

export function recordThreadOpen(method: string, parameters: Record<string, unknown>) {
    fs.appendFileSync(
        stateFile('thread-opens.jsonl'),
        `${JSON.stringify({ method, sandbox: parameters.sandbox, approvalPolicy: parameters.approvalPolicy, approvalsReviewer: parameters.approvalsReviewer, developerInstructions: parameters.developerInstructions })}\n`,
    );
}

/**
 * The `config/read` answer: `config.sandbox_workspace_write` from a `config-sandbox-workspace-write.json` file in the
 * state directory, standing in for the `[sandbox_workspace_write]` table of the user's `config.toml`.
 */
export function readFakeConfig(): { config: Record<string, unknown>; origins: object } {
    const file = stateFile('config-sandbox-workspace-write.json');
    const workspaceWrite = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, 'utf8')) as unknown)
        : null;
    return { config: { sandbox_workspace_write: workspaceWrite }, origins: {} };
}

/**
 * The `config/batchWrite` answer: appends the edits to `config-writes.jsonl`, standing in for the user's `config.toml`.
 */
export function writeFakeConfig(parameters: Record<string, unknown>): {
    status: 'ok';
    version: string;
} {
    fs.appendFileSync(
        stateFile('config-writes.jsonl'),
        `${JSON.stringify({ edits: parameters.edits })}\n`,
    );
    return { status: 'ok', version: 'fake' };
}

/**
 * Appends the permission, collaboration-mode, and service-tier fields of one `turn/start` to `turn-starts.jsonl`.
 */
export function recordTurnStart(parameters: Record<string, unknown>) {
    const fields = [
        'approvalPolicy',
        'approvalsReviewer',
        'sandboxPolicy',
        'collaborationMode',
        'serviceTier',
    ];
    const entry = Object.fromEntries(
        fields.flatMap((field) => (field in parameters ? [[field, parameters[field]]] : [])),
    );
    fs.appendFileSync(stateFile('turn-starts.jsonl'), `${JSON.stringify(entry)}\n`);
}

/**
 * How long `thread/resume` waits before answering, read from a `resume-delay-ms` file in the state directory, as a
 * loaded Codex takes a moment to replay a long thread. Zero when the file is absent.
 */
export function resumeDelayMs(): number {
    const file = stateFile('resume-delay-ms');
    return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) || 0 : 0;
}

/**
 * The saved thread `thread/resume` reopens, or the error Codex answers with. While a `<threadId>.writer-held` file
 * exists beside the thread, resuming it fails as Codex does when another client (the Codex app, a `codex` TUI) still
 * holds that thread's writer; deleting the file releases it.
 */
export function resumeSavedThread(
    threadId: string,
): { thread: FakeThread } | { error: { code: number; message: string } } {
    if (fs.existsSync(threadPath(threadId, 'writer-held')))
        return {
            error: { code: -32600, message: `thread ${threadId} already has an active writer` },
        };
    const thread = readSavedThread(threadId);
    return thread
        ? { thread }
        : { error: { code: -32600, message: `no rollout found for thread id ${threadId}` } };
}

/**
 * Where `FAKE_CODEX_SESSIONS_DIR` asks threads to keep a rollout; unset, the fake writes none.
 */
function rolloutSessionsDirectory() {
    return process.env.FAKE_CODEX_SESSIONS_DIR;
}

/**
 * A new thread id: a UUIDv7 when the fake writes rollouts, since Caxri finds a rollout by the time the id encodes.
 */
export function newThreadId() {
    if (!rolloutSessionsDirectory()) return crypto.randomUUID();
    const time = Date.now().toString(16).padStart(12, '0');
    const random = crypto.randomUUID().replaceAll('-', '');
    return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(13, 16)}-${random.slice(16, 20)}-${random.slice(20)}`;
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Appends a user message to the thread's rollout as codex-cli 0.164.0-alpha.8 records it: an `item_completed` event
 * carrying the app-server item id, the client id, and each image as the data URL it was sent with, then the prompt's
 * `response_item` message, which is what a reader of the conversation (citing a Session) parses.
 */
export function recordRolloutUserMessage(
    threadId: string,
    turnId: string,
    user: { id: string; clientId: string | null; content: FakeInput[] },
) {
    const sessions = rolloutSessionsDirectory();
    if (!sessions) return;
    const created = new Date(Number.parseInt(threadId.replaceAll('-', '').slice(0, 12), 16));
    const day = path.join(
        sessions,
        String(created.getFullYear()),
        pad(created.getMonth() + 1),
        pad(created.getDate()),
    );
    fs.mkdirSync(day, { recursive: true });
    const clock = `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}T${pad(created.getHours())}-${pad(created.getMinutes())}-${pad(created.getSeconds())}`;
    const content = user.content.map((entry) =>
        entry.type === 'image' ? { type: 'image', image_url: entry.url } : entry,
    );
    const item = { type: 'UserMessage', id: user.id, client_id: user.clientId, content };
    const message = {
        type: 'message',
        role: 'user',
        content: user.content.map((entry) =>
            entry.type === 'image'
                ? { type: 'input_image', image_url: entry.url }
                : { type: 'input_text', text: entry.text ?? '' },
        ),
    };
    fs.appendFileSync(
        path.join(day, `rollout-${clock}-${threadId}.jsonl`),
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: threadId, turn_id: turnId, item } })}\n${JSON.stringify({ type: 'response_item', payload: message })}\n`,
    );
}
