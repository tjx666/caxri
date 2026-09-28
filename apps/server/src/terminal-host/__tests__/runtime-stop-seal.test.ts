import { readFile } from 'node:fs/promises';

import type { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import type { TerminalExecutionExit } from '../engine/engine';
import type { TerminalHostMessage, TerminalHostRequestEnvelope } from '../protocol';
import type { TerminalHostRuntime } from '../runtime';
import {
    cleanupRuntimeFixtures,
    createRuntime,
    emptySnapshot,
    fakeAgentLauncher,
    fakeEngine,
    lifecycleScope,
    privateRequest,
    reserveLaunch,
    startAgentLaunch,
    terminal,
} from './runtime-fixtures';

afterEach(cleanupRuntimeFixtures);

const attachmentId = 'attachment-1';

function scope(
    capability: Extract<TerminalHostRequestEnvelope['scope'], { scope: 'terminal' }>['capability'],
    ptyGeneration = 1,
    hasAttachment = false,
): TerminalHostRequestEnvelope['scope'] {
    return {
        ...lifecycleScope(ptyGeneration),
        capability,
        ...(hasAttachment && { attachmentId }),
    };
}

function send(
    runtime: TerminalHostRuntime,
    request: TerminalHostRequestEnvelope['request'],
    requestScope: TerminalHostRequestEnvelope['scope'],
    id: string,
): Promise<void> {
    return runtime.accept(privateRequest(request, requestScope, id));
}

function stop(
    runtime: TerminalHostRuntime,
    id: string,
    isPersistingSnapshot = true,
    ptyGeneration = 1,
): Promise<void> {
    return send(
        runtime,
        { method: 'terminal.stop', params: { persistSnapshot: isPersistingSnapshot } },
        scope('terminal.lifecycle', ptyGeneration),
        id,
    );
}

function reply(messages: TerminalHostMessage[], id: string): TerminalHostMessage | undefined {
    return messages.find((message) => message.type === 'reply' && message.id === id);
}

async function denialReasons(logger: StructuredLogger): Promise<Record<string, string>> {
    await logger.flush();
    const reasons: Record<string, string> = {};
    const lines = (await readFile(logger.path, 'utf8')).split('\n');
    for (const line of lines) {
        if (!line.includes('"event":"terminal_host.request_failed"')) continue;
        const entry = JSON.parse(line) as {
            correlationId: string;
            fields: { code: string; reason?: string };
        };
        if (entry.fields.code === 'CAPABILITY_DENIED' && entry.fields.reason)
            reasons[entry.correlationId] = entry.fields.reason;
    }
    return reasons;
}

/**
 * Starts generation 1 as a managed Agent Terminal with a Desktop attachment, the state a restart or suspend stops.
 */
async function startAttachedAgent(runtime: TerminalHostRuntime): Promise<void> {
    await reserveLaunch(runtime, { ptyGeneration: 1, terminalId: terminal.id });
    await startAgentLaunch(runtime, 1, 'start-1');
    runtime.projectManagedAgentEvent({
        type: 'started',
        terminalId: terminal.id,
        launchId: 'launch-1',
        processId: 101,
    });
    await send(
        runtime,
        { method: 'terminal.attach', params: { attachmentId } },
        scope('terminal.view', 1, true),
        'attach-1',
    );
}

const denied = { ok: false, error: { code: 'CAPABILITY_DENIED' } };

interface RuntimeInternals {
    colors: ReadonlyMap<string, { background: string; foreground: string }>;
    projectExecutionExit(event: TerminalExecutionExit): Promise<void>;
}

function startShell(
    runtime: TerminalHostRuntime,
    ptyGeneration: number,
    id: string,
    colors?: { background: string; foreground: string },
): Promise<void> {
    return send(
        runtime,
        {
            method: 'terminal.start',
            params: {
                record: terminal,
                executable: '/bin/zsh',
                args: [],
                environment: {},
                ...(colors && { colors }),
            },
        },
        scope('terminal.lifecycle', ptyGeneration),
        id,
    );
}

/**
 * `terminal.stop` waits for managed Agent cancellation before it stops the PTY (#1425). Admission must seal the old
 * generation first, so nothing that arrives during that wait can still drive the PTY being stopped.
 */
describe('architecture-a3b-terminal-host: stop admission seals the old generation', () => {
    it('rejects old-generation input, resize, observation, and signals while Agent cancellation blocks the stop', async () => {
        const engine = fakeEngine();
        const agent = fakeAgentLauncher();
        const cancellation = Promise.withResolvers<boolean>();
        agent.cancel.mockReturnValueOnce(cancellation.promise);
        const { logger, messages, runtime } = createRuntime(engine.owner, agent.owner);
        await startAttachedAgent(runtime);

        const stopping = stop(runtime, 'stop-1');
        expect(agent.cancel).toHaveBeenCalledWith(terminal.id, 'launch-1');
        const blocked = {
            'input-during-stop': send(
                runtime,
                { method: 'terminal.input', params: { data: 'typed during restart' } },
                scope('terminal.input', 1, true),
                'input-during-stop',
            ),
            'agent-submit-during-stop': send(
                runtime,
                {
                    method: 'terminal.agent.submit',
                    params: { launchId: 'launch-1', text: 'submitted during restart' },
                },
                scope('terminal.agent.input'),
                'agent-submit-during-stop',
            ),
            'resize-during-stop': send(
                runtime,
                { method: 'terminal.resize', params: { cols: 132, rows: 43 } },
                scope('terminal.view', 1, true),
                'resize-during-stop',
            ),
            'observe-during-stop': send(
                runtime,
                { method: 'terminal.observe', params: { observerId: 'observer-1' } },
                scope('terminal.observe'),
                'observe-during-stop',
            ),
            'signal-during-stop': send(
                runtime,
                {
                    method: 'terminal.signal',
                    params: { expectedProcessId: 42, signal: 'SIGINT' },
                },
                scope('terminal.lifecycle'),
                'signal-during-stop',
            ),
            'agent-signal-during-stop': send(
                runtime,
                {
                    method: 'terminal.agent.signal',
                    params: { launchId: 'launch-1', signal: 'SIGINT' },
                },
                scope('terminal.lifecycle'),
                'agent-signal-during-stop',
            ),
        };
        await Promise.all(Object.values(blocked));

        for (const id of Object.keys(blocked)) expect(reply(messages, id)).toMatchObject(denied);
        expect(engine.write).not.toHaveBeenCalled();
        expect(engine.writeWithCompletion).not.toHaveBeenCalled();
        expect(engine.owner.resize).not.toHaveBeenCalled();
        expect(engine.owner.observe).not.toHaveBeenCalled();
        expect(engine.owner.signalExact).not.toHaveBeenCalled();
        expect(agent.signalExact).not.toHaveBeenCalled();
        const reasons = await denialReasons(logger);
        for (const id of Object.keys(blocked)) expect(reasons[id]).toBe('sealed');

        cancellation.resolve(true);
        await stopping;
        expect(reply(messages, 'stop-1')).toMatchObject({ ok: true, result: { stopped: true } });
        expect(engine.owner.restartBarrier).toHaveBeenCalledOnce();
    });

    it('lets a restart barrier retry the stop of its sealed generation after the first attempt failed', async () => {
        const engine = fakeEngine();
        engine.owner.restartBarrier.mockImplementationOnce(() =>
            Promise.reject(new Error('parser barrier failed')),
        );
        const { messages, runtime } = createRuntime(engine.owner, fakeAgentLauncher().owner);
        await startAttachedAgent(runtime);

        await stop(runtime, 'stop-failed');
        await stop(runtime, 'stop-retry');
        await reserveLaunch(runtime, { ptyGeneration: 2, terminalId: terminal.id });

        expect(reply(messages, 'stop-failed')).toMatchObject({ ok: false });
        expect(reply(messages, 'stop-retry')).toMatchObject({
            ok: true,
            result: { stopped: true },
        });
        expect(reply(messages, `reserve-${terminal.id}-2`)).toMatchObject({ ok: true });
    });

    it('joins a repeated stop to the one in flight, so concurrent restart barriers share one final snapshot', async () => {
        const engine = fakeEngine();
        const finalScreen = { ...emptySnapshot, payload: 'final screen' };
        engine.owner.restartBarrier.mockImplementationOnce(() => Promise.resolve(finalScreen));
        const agent = fakeAgentLauncher();
        const cancellation = Promise.withResolvers<boolean>();
        agent.cancel.mockReturnValueOnce(cancellation.promise);
        const { messages, runtime } = createRuntime(engine.owner, agent.owner);
        await startAttachedAgent(runtime);

        const restarting = stop(runtime, 'restart-stop');
        const suspending = stop(runtime, 'suspend-stop');
        const discarding = stop(runtime, 'discard-stop', false);
        cancellation.resolve(true);
        await Promise.all([restarting, suspending, discarding]);

        const stopped = { ok: true, result: { snapshot: finalScreen, stopped: true } };
        expect(reply(messages, 'restart-stop')).toMatchObject(stopped);
        expect(reply(messages, 'suspend-stop')).toMatchObject(stopped);
        expect(engine.owner.restartBarrier).toHaveBeenCalledOnce();
        // The discard ran only after the restart barrier settled, then released the stopped identity.
        expect(reply(messages, 'discard-stop')).toMatchObject({
            ok: true,
            result: { snapshot: null, stopped: true },
        });
        expect(engine.owner.close).toHaveBeenCalledOnce();
    });

    it('still ends the PTY and frees the next reservation when Agent cancellation fails', async () => {
        const engine = fakeEngine();
        const agent = fakeAgentLauncher();
        agent.cancel.mockImplementationOnce(() => Promise.reject(new Error('launcher lost')));
        const { messages, runtime } = createRuntime(engine.owner, agent.owner);
        await startAttachedAgent(runtime);

        await stop(runtime, 'stop-1');
        await reserveLaunch(runtime, { ptyGeneration: 2, terminalId: terminal.id });

        expect(reply(messages, 'stop-1')).toMatchObject({ ok: true, result: { stopped: true } });
        expect(engine.owner.restartBarrier).toHaveBeenCalledOnce();
        expect(reply(messages, `reserve-${terminal.id}-2`)).toMatchObject({ ok: true });
    });

    it('admits the next generation only after the stop reaches the PTY, and that generation regains authority', async () => {
        const engine = fakeEngine();
        const agent = fakeAgentLauncher();
        const cancellation = Promise.withResolvers<boolean>();
        agent.cancel.mockReturnValueOnce(cancellation.promise);
        const { logger, messages, runtime } = createRuntime(engine.owner, agent.owner);
        await startAttachedAgent(runtime);

        const stopping = stop(runtime, 'stop-1');
        await send(
            runtime,
            { method: 'terminal.reserve', params: terminal },
            scope('terminal.lifecycle', 2),
            'reserve-2-during-stop',
        );
        await send(
            runtime,
            { method: 'terminal.snapshot', params: {} },
            scope('terminal.view'),
            'snapshot-during-stop',
        );
        expect(reply(messages, 'reserve-2-during-stop')).toMatchObject(denied);
        expect((await denialReasons(logger))['reserve-2-during-stop']).toBe('sealed');
        expect(reply(messages, 'snapshot-during-stop')).toMatchObject({ ok: true });

        cancellation.resolve(true);
        await stopping;
        await reserveLaunch(runtime, { ptyGeneration: 2, terminalId: terminal.id });
        await startShell(runtime, 2, 'start-2');
        await send(
            runtime,
            { method: 'terminal.input', params: { data: 'typed after restart' } },
            scope('terminal.input', 2, true),
            'input-2',
        );

        expect(reply(messages, 'start-2')).toMatchObject({ ok: true });
        expect(reply(messages, 'input-2')).toMatchObject({ ok: true, result: { accepted: true } });
        expect(engine.write).toHaveBeenCalledExactlyOnceWith(terminal.id, 'typed after restart');
    });

    it('never tears down a generation reserved after the old PTY exited during the wait', async () => {
        const engine = fakeEngine();
        const agent = fakeAgentLauncher();
        const cancellation = Promise.withResolvers<boolean>();
        agent.cancel.mockReturnValueOnce(cancellation.promise);
        const { messages, runtime } = createRuntime(engine.owner, agent.owner);
        await startAttachedAgent(runtime);

        const discarding = stop(runtime, 'discard-1', false);
        // The PTY exits on its own while the discard still waits, and Server Core relaunches the Terminal.
        await (runtime as unknown as RuntimeInternals).projectExecutionExit({
            capture: Promise.resolve(emptySnapshot),
            exitCode: 0,
            record: terminal,
        });
        await reserveLaunch(runtime, { ptyGeneration: 2, terminalId: terminal.id });
        await startShell(runtime, 2, 'start-2');
        await send(
            runtime,
            { method: 'terminal.attach', params: { attachmentId } },
            scope('terminal.view', 2, true),
            'attach-2',
        );
        cancellation.resolve(true);
        await discarding;
        await send(
            runtime,
            { method: 'terminal.input', params: { data: 'typed after relaunch' } },
            scope('terminal.input', 2, true),
            'input-2',
        );

        expect(reply(messages, 'discard-1')).toMatchObject({ ok: true, result: { stopped: true } });
        expect(reply(messages, 'start-2')).toMatchObject({ ok: true });
        expect(engine.owner.close).not.toHaveBeenCalled();
        expect(reply(messages, 'input-2')).toMatchObject({ ok: true, result: { accepted: true } });
    });
});

describe('architecture-a3b-terminal-host: failed launch restores only its own reservation', () => {
    it('does not resurrect a reservation retired while the failed launch cancels its Agent', async () => {
        const engine = fakeEngine();
        engine.start.mockImplementationOnce(() => {
            throw new Error('spawn failed');
        });
        const agent = fakeAgentLauncher();
        const cancellation = Promise.withResolvers<boolean>();
        agent.cancel.mockReturnValueOnce(cancellation.promise);
        const { messages, runtime } = createRuntime(engine.owner, agent.owner);
        await reserveLaunch(runtime, { ptyGeneration: 1, terminalId: terminal.id });

        const starting = startAgentLaunch(runtime, 1, 'start-failing');
        expect(agent.cancel).toHaveBeenCalledWith(terminal.id, 'launch-1');
        await send(
            runtime,
            { method: 'terminal.retire', params: { terminalId: terminal.id } },
            { scope: 'server', capability: 'terminal.lifecycle' },
            'retire-during-failed-start',
        );
        cancellation.resolve(true);
        await starting;

        expect(reply(messages, 'start-failing')).toMatchObject({ ok: false });
        expect(reply(messages, 'retire-during-failed-start')).toMatchObject({ ok: true });
        await send(
            runtime,
            { method: 'terminal.snapshot', params: {} },
            scope('terminal.view'),
            'snapshot-after-retire',
        );
        expect(reply(messages, 'snapshot-after-retire')).toMatchObject(denied);
    });

    it('gives a still-live previous PTY its colors back when the relaunch cannot start', async () => {
        const engine = fakeEngine();
        const { messages, runtime } = createRuntime(engine.owner);
        const previousColors = { background: '#000000', foreground: '#ffffff' };
        await reserveLaunch(runtime, { ptyGeneration: 1, terminalId: terminal.id });
        await startShell(runtime, 1, 'start-1', previousColors);
        engine.start.mockImplementationOnce(() => {
            throw new Error('Terminal already has a live PTY');
        });

        await reserveLaunch(runtime, { ptyGeneration: 2, terminalId: terminal.id });
        await startShell(runtime, 2, 'start-2', { background: '#ffffff', foreground: '#000000' });

        expect(reply(messages, 'start-2')).toMatchObject({ ok: false });
        expect((runtime as unknown as RuntimeInternals).colors.get(terminal.id)).toEqual(
            previousColors,
        );
    });
});
