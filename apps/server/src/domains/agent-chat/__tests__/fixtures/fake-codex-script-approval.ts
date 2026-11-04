/**
 * The approval steps of a scripted fake Codex turn (`fake-codex-script.ts`): a command that asks for approval and a
 * file change that asks for approval. Both wait for the Client's decision and report whether it accepted. Kept apart so
 * the script player stays readable. This file is loaded by Node's type stripping, so it uses only erasable TypeScript
 * syntax and `.ts` import specifiers.
 */
import crypto from 'node:crypto';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

type Decision = { decision?: string } | undefined;

function isAccepted(response: Decision): boolean {
    return response?.decision === 'accept' || response?.decision === 'acceptForSession';
}

/**
 * Asks for approval to run `item` and waits. A declined (or interrupted) command stops the script.
 */
export async function playCommandApproval(
    io: FakeCodexIo,
    turn: FakeTurn,
    item: { id: string; command: string; cwd: string },
    output: string,
): Promise<'continue' | 'stop'> {
    io.startItem(turn, { ...item, type: 'commandExecution', status: 'inProgress' });
    const response = (await io.serverRequest('item/commandExecution/requestApproval', {
        turnId: turn.id,
        itemId: item.id,
        startedAtMs: Date.now(),
        command: item.command,
        cwd: item.cwd,
    })) as Decision;
    if (!isAccepted(response)) {
        io.completeItem(turn, { ...item, type: 'commandExecution', status: 'declined' });
        await io.streamMessage(turn, 'The command was declined.', 0);
        return 'stop';
    }
    io.notifyTurn(turn, 'item/commandExecution/outputDelta', {
        turnId: turn.id,
        itemId: item.id,
        delta: output,
    });
    io.completeItem(turn, {
        ...item,
        type: 'commandExecution',
        status: 'completed',
        aggregatedOutput: output,
        exitCode: 0,
        durationMs: 900,
    });
    return 'continue';
}

/**
 * Announces a file change that updates each of `paths` (absolute), asks for approval, and waits. Nothing is written to
 * disk. A declined change stops the script, as the Agent would stop there.
 */
export async function playFileApproval(
    io: FakeCodexIo,
    turn: FakeTurn,
    paths: readonly string[],
): Promise<'continue' | 'stop'> {
    const change = {
        type: 'fileChange',
        id: crypto.randomUUID(),
        status: 'inProgress',
        changes: paths.map((path) => ({
            path,
            kind: { type: 'update', move_path: null },
            diff: '@@ -1,1 +1,1 @@\n-before\n+after\n',
        })),
    };
    io.startItem(turn, { ...change });
    const response = (await io.serverRequest('item/fileChange/requestApproval', {
        turnId: turn.id,
        itemId: change.id,
        startedAtMs: Date.now(),
        grantRoot: null,
    })) as Decision;
    const isDecisionAccepted = isAccepted(response);
    io.completeItem(turn, { ...change, status: isDecisionAccepted ? 'completed' : 'declined' });
    if (isDecisionAccepted) return 'continue';
    await io.streamMessage(turn, 'The change was declined.', 0);
    return 'stop';
}
