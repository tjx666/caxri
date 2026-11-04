import type { ServerEvent } from '@caxri/protocol';
import { serverEventSchema } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type * as AgentDelegationModule from '../../agent-delegation';
import type { AgentDelegationService } from '../../agent-delegation';
import { createAgentCommandRuntime } from '../command-runtime';

type DelegationOptions = ConstructorParameters<typeof AgentDelegationService>[0];

/**
 * The options the composed runtime hands to its delegation service, captured as the service is constructed, so a test
 * calls the wiring the runtime owns without a launch. The service itself stays the real one.
 */
const captured = vi.hoisted(() => ({ options: undefined as unknown }));

vi.mock('../../agent-delegation', async (importOriginal) => {
    const original = await importOriginal<typeof AgentDelegationModule>();
    return {
        ...original,
        AgentDelegationService: class extends original.AgentDelegationService {
            constructor(options: DelegationOptions) {
                super(options);
                captured.options = options;
            }
        },
    };
});

const CHAT_TERMINAL = { id: 'chat-terminal', sessionId: 'session', surface: 'chat' };
const PTY_TERMINAL = { id: 'pty-terminal', sessionId: 'session' };
const TURN = 'turn-1';
const failure = { provider: 'claude' as const, terminalId: CHAT_TERMINAL.id, turnId: TURN };

/**
 * A Chat snapshot whose failed turn carries a usage-limit notice that resets at `resetsAt`.
 */
const noticeSnapshot = (resetsAt: number) => ({
    activeTurnId: undefined,
    items: [{ type: 'notice', turnId: TURN, usageLimit: { resetsAt } }],
});

function createRuntime(
    overrides: {
        snapshot?: unknown;
        guard?: { resetsAt?: number };
    } = {},
) {
    const emit = vi.fn<(event: ServerEvent) => void>();
    const snapshot = vi.fn(() => overrides.snapshot);
    createAgentCommandRuntime({
        agentChat: { delegation: { snapshot } } as never,
        agentEnvironment: {} as never,
        coordinator: {} as never,
        database: {
            activeAgentDispatches: () => [],
            agentDelegations: {
                active: () => [],
                all: () => [],
                questions: { cancelAllOpen: () => [] },
            },
            getTerminal: (id: string) =>
                [CHAT_TERMINAL, PTY_TERMINAL].find((terminal) => terminal.id === id),
        } as never,
        emit,
        launchSettings: vi.fn(),
        logger: { write: vi.fn() } as never,
        settings: () => ({}) as never,
        terminalDirectoryIdentity: vi.fn(),
        terminals: {} as never,
        terminalWorkingDirectory: vi.fn(),
        usageGuards: { assertAdmitted: vi.fn(), current: () => overrides.guard } as never,
        userDataPath: 'unused',
    });
    return { emit, options: captured.options as DelegationOptions, snapshot };
}

describe('the delegation progress the runtime emits', () => {
    it('forwards a step the service reports as an agent.delegation.progress event', () => {
        const { emit, options } = createRuntime();

        options.onProgress?.({
            sessionId: 'session-1',
            delegationId: 'delegation-1',
            step: 'Running pnpm lint',
        });

        expect(emit).toHaveBeenCalledTimes(1);
        const event = emit.mock.calls[0][0];
        expect(event).toEqual({
            event: 'agent.delegation.progress',
            payload: {
                sessionId: 'session-1',
                delegationId: 'delegation-1',
                step: 'Running pnpm lint',
            },
        });
        expect(serverEventSchema.parse(event)).toEqual(event);
    });

    it('forwards a Session that is between steps without a step', () => {
        const { emit, options } = createRuntime();

        options.onProgress?.({ sessionId: 'session-1', delegationId: 'delegation-1' });

        expect(serverEventSchema.parse(emit.mock.calls[0][0])).toMatchObject({
            event: 'agent.delegation.progress',
            payload: { sessionId: 'session-1', delegationId: 'delegation-1' },
        });
    });
});

describe('the reset time of a usage-limit failure the runtime looks up', () => {
    it('is the limit notice on the failed turn when the usage guard knows no time', () => {
        const { options } = createRuntime({ snapshot: noticeSnapshot(9000) });

        expect(options.limitResetsAt?.(failure)).toBe(9000);
    });

    it('is the usage guard when the failed turn has no limit notice', () => {
        const { options } = createRuntime({
            snapshot: { activeTurnId: undefined, items: [] },
            guard: { resetsAt: 7000 },
        });

        expect(options.limitResetsAt?.(failure)).toBe(7000);
    });

    it.each([
        [9000, 7000, 9000],
        [7000, 9000, 9000],
    ])('is the later of a notice at %i and a guard at %i', (noticed, guarded, expected) => {
        const { options } = createRuntime({
            snapshot: noticeSnapshot(noticed),
            guard: { resetsAt: guarded },
        });

        expect(options.limitResetsAt?.(failure)).toBe(expected);
    });

    it('is unknown when neither the failed turn nor the guard knows one', () => {
        const { options } = createRuntime({ snapshot: { activeTurnId: undefined, items: [] } });

        expect(options.limitResetsAt?.(failure)).toBeUndefined();
    });

    it('reads no Chat for a failure of a PTY Terminal or one with no turn, and still uses the guard', () => {
        const { options, snapshot } = createRuntime({
            snapshot: noticeSnapshot(9000),
            guard: { resetsAt: 7000 },
        });

        expect(options.limitResetsAt?.({ ...failure, terminalId: PTY_TERMINAL.id })).toBe(7000);
        expect(options.limitResetsAt?.({ ...failure, turnId: undefined })).toBe(7000);
        expect(snapshot).not.toHaveBeenCalledWith(PTY_TERMINAL.id);
    });
});
