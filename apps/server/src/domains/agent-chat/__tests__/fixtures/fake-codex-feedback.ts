import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

/**
 * A finished Hook run in the shape Codex 0.165's app-server reports it (`HookRunSummary`). Codex never reports an exit
 * code: a Hook that exits non-zero without output becomes an `error` entry reading `hook exited with code N`.
 */
function hookRun(status: string, entries: Array<{ kind: string; text: string }>) {
    const now = Date.now();
    return {
        id: `preToolUse:0:${status}`,
        eventName: 'preToolUse',
        handlerType: 'command',
        executionMode: 'sync',
        scope: 'turn',
        source: 'user',
        sourcePath: '/fake/home/.codex/hooks.json',
        displayOrder: 0,
        status,
        statusMessage: 'Checking the command',
        startedAt: now,
        completedAt: now,
        durationMs: 12,
        entries,
    };
}

/**
 * The `hookfeedback` turn: Codex feedback that is not a conversation item, in arrival order. A Hook that completed
 * (silent in Chat), a Hook that failed, one that blocked a command, a runtime warning sent twice (one notice), a
 * configuration warning, and a model reroute, then a reply.
 */
export async function runProviderFeedback(io: FakeCodexIo, turn: FakeTurn) {
    const hook = (run: ReturnType<typeof hookRun>) =>
        io.notifyTurn(turn, 'hook/completed', { turnId: turn.id, run });
    hook(hookRun('completed', []));
    hook(hookRun('failed', [{ kind: 'error', text: 'guard.sh: line 3: jq: command not found' }]));
    hook(
        hookRun('blocked', [
            {
                kind: 'feedback',
                text: 'Force pushes to main are not allowed.\nOpen a pull request instead.',
            },
        ]),
    );
    for (let index = 0; index < 2; index += 1)
        io.notifyTurn(turn, 'warning', {
            message: 'Exceeded skills context budget of 2%. All skill descriptions were removed.',
        });
    io.send({
        method: 'configWarning',
        params: { summary: 'Ignored unknown key `model_reasoning` in config.toml.' },
    });
    io.notifyTurn(turn, 'model/rerouted', {
        turnId: turn.id,
        fromModel: 'gpt-5.5-codex',
        toModel: 'gpt-5.5',
        reason: 'highRiskCyberActivity',
    });
    await io.streamMessage(turn, 'The guard Hook stopped the push, so nothing was changed.', 0);
}
