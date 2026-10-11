/**
 * Thread persistence for the fake Codex app-server (`fake-codex-app-server.ts`). Threads persist to
 * `FAKE_CODEX_STATE_DIR` (or the OS temp directory) so `thread/resume` returns real history. Each thread open also
 * appends its method, sandbox, and approval policy to `thread-opens.jsonl` there, so tests can assert the configuration
 * Caxri asked for.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { FakeThread } from './fake-codex-io.ts';

export function fakeCodexStateDirectory() {
    const directory =
        process.env.FAKE_CODEX_STATE_DIR ?? path.join(os.tmpdir(), 'caxri-fake-codex');
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function stateFile(name: string) {
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
        `${JSON.stringify({ method, sandbox: parameters.sandbox, approvalPolicy: parameters.approvalPolicy, approvalsReviewer: parameters.approvalsReviewer })}\n`,
    );
}

/**
 * Appends the permission and collaboration-mode fields of one `turn/start` to `turn-starts.jsonl`.
 */
export function recordTurnStart(parameters: Record<string, unknown>) {
    const fields = ['approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'collaborationMode'];
    const entry = Object.fromEntries(
        fields.flatMap((field) => (field in parameters ? [[field, parameters[field]]] : [])),
    );
    fs.appendFileSync(stateFile('turn-starts.jsonl'), `${JSON.stringify(entry)}\n`);
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
