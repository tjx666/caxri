import { readFile } from 'node:fs/promises';

import type { TerminalRecord } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { TerminalExecutionExit } from '../engine/engine';
import { RETIRED_TERMINAL_FENCE_LIMIT } from '../generation-ledger';
import type { TerminalHostMessage } from '../protocol';
import type { TerminalHostRuntime } from '../runtime';
import {
    cleanupRuntimeFixtures,
    createRuntime,
    emptySnapshot,
    fakeAgentLauncher,
    fakeEngine,
    lifecycleScope,
    privateRequest,
    startAgentLaunch,
    terminal,
} from './runtime-fixtures';

afterEach(cleanupRuntimeFixtures);

interface RuntimeInternals {
    generations: { retired: Set<string>; started: Map<string, number> };
    colors: Map<string, unknown>;
    identities: Map<string, unknown>;
    projectExecutionExit(event: TerminalExecutionExit): Promise<void>;
}

function internals(runtime: TerminalHostRuntime): RuntimeInternals {
    return runtime as unknown as RuntimeInternals;
}

function reserve(
    runtime: TerminalHostRuntime,
    ptyGeneration: number,
    id: string,
    record: TerminalRecord = terminal,
): Promise<void> {
    return runtime.accept(
        privateRequest(
            { method: 'terminal.reserve', params: record },
            lifecycleScope(ptyGeneration, record.id),
            id,
        ),
    );
}

function start(
    runtime: TerminalHostRuntime,
    ptyGeneration: number,
    id: string,
    record: TerminalRecord = terminal,
): Promise<void> {
    return runtime.accept(
        privateRequest(
            {
                method: 'terminal.start',
                params: { record, executable: '/bin/zsh', args: [], environment: {} },
            },
            lifecycleScope(ptyGeneration, record.id),
            id,
        ),
    );
}

function discard(runtime: TerminalHostRuntime, ptyGeneration: number, id: string): Promise<void> {
    return runtime.accept(
        privateRequest(
            { method: 'terminal.stop', params: { persistSnapshot: false } },
            lifecycleScope(ptyGeneration),
            id,
        ),
    );
}

function retire(runtime: TerminalHostRuntime, terminalId: string, id: string): Promise<void> {
    return runtime.accept(
        privateRequest(
            { method: 'terminal.retire', params: { terminalId } },
            { scope: 'server', capability: 'terminal.lifecycle' },
            id,
        ),
    );
}

function reply(messages: TerminalHostMessage[], id: string): TerminalHostMessage | undefined {
    return messages.find((message) => message.type === 'reply' && message.id === id);
}

const denied = { ok: false, error: { code: 'CAPABILITY_DENIED' } };

/**
 * Generation retention across permanent closure (#1176): only `terminal.retire` releases an ID's baseline, and the
 * released ID stays fenced so a late reserve or start cannot fall back to the no-baseline rule.
 */
describe('architecture-a3b-terminal-host: Terminal generation retention', () => {
    it('keeps generation state bounded after 200 permanently retired Terminals', async () => {
        const engine = fakeEngine();
        const { messages, runtime } = createRuntime(engine.owner);
        for (let index = 0; index < 200; index += 1) {
            const record = { ...terminal, id: `terminal-${index}` };
            // eslint-disable-next-line no-await-in-loop -- each Terminal starts before its permanent closure
            await reserve(runtime, 1, `reserve-${index}`, record);
            // eslint-disable-next-line no-await-in-loop -- each Terminal starts before its permanent closure
            await start(runtime, 1, `start-${index}`, record);
            // eslint-disable-next-line no-await-in-loop -- each Terminal starts before its permanent closure
            await retire(runtime, record.id, `retire-${index}`);
        }

        expect(engine.start).toHaveBeenCalledTimes(200);
        expect(engine.owner.close).toHaveBeenCalledTimes(200);
        expect(reply(messages, 'retire-199')).toMatchObject({
            ok: true,
            result: { retired: true },
        });
        const { generations, identities } = internals(runtime);
        expect(generations.started.size).toBe(0);
        expect(identities.size).toBe(0);
        expect(generations.retired.size).toBeLessThanOrEqual(RETIRED_TERMINAL_FENCE_LIMIT);
    });

    it('lets a discarded launch retry at exactly the next generation', async () => {
        const engine = fakeEngine();
        const { messages, runtime } = createRuntime(engine.owner);
        await reserve(runtime, 1, 'reserve-1');
        await start(runtime, 1, 'start-1');
        await discard(runtime, 1, 'discard-1');

        await reserve(runtime, 1, 'reserve-stale');
        await reserve(runtime, 2, 'reserve-2');
        await start(runtime, 2, 'start-2');

        expect(reply(messages, 'discard-1')).toMatchObject({ ok: true });
        expect(reply(messages, 'reserve-stale')).toMatchObject(denied);
        expect(reply(messages, 'reserve-2')).toMatchObject({ ok: true });
        expect(reply(messages, 'start-2')).toMatchObject({ ok: true, result: { processId: 42 } });
        expect(engine.start).toHaveBeenCalledTimes(2);
        expect(internals(runtime).generations.started.get(terminal.id)).toBe(2);
    });

    it('rejects a late reserve or start after permanent closure at any generation', async () => {
        const engine = fakeEngine();
        const { logger, messages, runtime } = createRuntime(engine.owner);
        await reserve(runtime, 1, 'reserve-1');
        await start(runtime, 1, 'start-1');
        const pending = { ...terminal, id: 'terminal-pending' };
        await reserve(runtime, 1, 'reserve-pending', pending);
        await retire(runtime, terminal.id, 'retire-started');
        await retire(runtime, pending.id, 'retire-pending');

        await start(runtime, 1, 'start-pending-late', pending);
        await reserve(runtime, 1, 'reserve-late-1');
        await reserve(runtime, 2, 'reserve-late-2');
        await start(runtime, 2, 'start-late-2');

        for (const id of ['start-pending-late', 'reserve-late-1', 'reserve-late-2', 'start-late-2'])
            expect(reply(messages, id)).toMatchObject(denied);
        expect(engine.start).toHaveBeenCalledOnce();
        expect(internals(runtime).identities.size).toBe(0);
        await logger.flush();
        const denials = (await readFile(logger.path, 'utf8'))
            .split('\n')
            .filter((line) => line.includes('"event":"terminal_host.request_failed"'));
        expect(denials).toHaveLength(4);
        for (const line of denials) expect(line).toContain('"reason":"retired"');
    });

    it('rejects a start whose reservation was discarded before launch', async () => {
        const engine = fakeEngine();
        const { messages, runtime } = createRuntime(engine.owner);
        await reserve(runtime, 1, 'reserve-1');
        await discard(runtime, 1, 'discard-reserved');
        await start(runtime, 1, 'start-after-discard');

        expect(reply(messages, 'start-after-discard')).toMatchObject(denied);
        expect(engine.start).not.toHaveBeenCalled();
    });

    it('fences a reservation that arrives while retirement cancels the managed Agent', async () => {
        const engine = fakeEngine();
        const agent = fakeAgentLauncher();
        const cancellation = Promise.withResolvers<boolean>();
        agent.cancel.mockReturnValueOnce(cancellation.promise);
        const { messages, runtime } = createRuntime(engine.owner, agent.owner);
        await reserve(runtime, 1, 'reserve-1');
        await startAgentLaunch(runtime, 1, 'start-agent');

        const retiring = retire(runtime, terminal.id, 'retire-agent');
        await reserve(runtime, 2, 'reserve-during-retire');
        cancellation.resolve(true);
        await retiring;

        expect(reply(messages, 'reserve-during-retire')).toMatchObject(denied);
        expect(agent.cancel).toHaveBeenCalledWith(terminal.id, 'launch-1');
        expect(internals(runtime).identities.size).toBe(0);
    });

    it('accepts the first reservation a replacement Host sees and relaunches after natural exit', async () => {
        const engine = fakeEngine();
        const { messages, runtime } = createRuntime(engine.owner);
        await start(runtime, 7, 'start-unreserved');
        await reserve(runtime, 7, 'reserve-7');
        await start(runtime, 7, 'start-7');
        await internals(runtime).projectExecutionExit({
            capture: Promise.resolve(emptySnapshot),
            exitCode: 0,
            record: terminal,
        });
        await reserve(runtime, 7, 'reserve-exited-stale');
        await reserve(runtime, 8, 'reserve-8');
        await start(runtime, 8, 'start-8');

        expect(reply(messages, 'start-unreserved')).toMatchObject(denied);
        expect(reply(messages, 'start-7')).toMatchObject({ ok: true });
        expect(messages).toContainEqual(
            expect.objectContaining({ event: 'terminal.exit', exitCode: 0 }),
        );
        expect(reply(messages, 'reserve-exited-stale')).toMatchObject(denied);
        expect(reply(messages, 'start-8')).toMatchObject({ ok: true });
        expect(engine.start).toHaveBeenCalledTimes(2);
    });

    it('still sends terminal.exit without a snapshot and cleans per-terminal state when capture rejects', async () => {
        const engine = fakeEngine();
        const { messages, runtime } = createRuntime(engine.owner);
        await reserve(runtime, 1, 'reserve-1');
        await start(runtime, 1, 'start-1');
        await internals(runtime).projectExecutionExit({
            capture: Promise.reject(new Error('parser barrier rejected')),
            exitCode: 3,
            record: terminal,
        });

        const exit = messages.find(
            (message) => message.type === 'event' && message.event === 'terminal.exit',
        );
        expect(exit).toMatchObject({ exitCode: 3 });
        expect(exit).not.toHaveProperty('snapshot');
        expect(internals(runtime).identities.size).toBe(0);
        expect(internals(runtime).colors.size).toBe(0);
    });
});
