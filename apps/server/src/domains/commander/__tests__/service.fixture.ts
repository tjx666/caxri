import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    BootstrapState,
    CommanderAgent,
    CommanderIdentity,
    TerminalKind,
} from '@caxri/protocol';
import { onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db';
import { AgentCommanderService } from '../service';

/**
 * A Commander service over a real database and workspace, with every process-level host operation faked: Terminals are
 * rows, a stop parks the row as `detached`, and a fresh relaunch marks it `running`.
 */
export async function fixture() {
    const directory = await realpath(await mkdtemp(`${tmpdir()}/caxri-commander-`));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const userRoot = join(directory, 'repository');
    await mkdir(userRoot);
    const userProject = database.createProject(userRoot);
    const userSession = database.createSession(userProject.id, 'shell').session;
    const terminalIdsAtStart: Array<string | undefined> = [];
    const createAndStartTerminal = vi.fn(
        (
            sessionId: string,
            kind: TerminalKind,
            cwd: string,
            beforeStart: (terminal: { id: string }) => void,
        ) => {
            const terminal = database.createTerminal(sessionId, kind, cwd);
            beforeStart(terminal);
            terminalIdsAtStart.push(database.agentCommanderRows()?.terminalId);
            return Promise.resolve(terminal);
        },
    );
    const sendFullStateChange = vi.fn<() => void>();
    const restoreTerminals = vi.fn<(sessionId: string) => void>();
    const cancelRestore = vi.fn<(sessionId: string) => Promise<void>>(() => Promise.resolve());
    const sendTerminalChange = vi.fn<(terminalId: string) => void>();
    const stopTerminal = vi.fn((terminalId: string) => {
        database.updateTerminalState(terminalId, 'detached');
        return Promise.resolve();
    });
    const relaunchFresh = vi.fn((terminalId: string) => {
        database.updateTerminalState(terminalId, 'running');
        return Promise.resolve();
    });
    const prepareLaunch = vi.fn<(agent: CommanderAgent, workspacePath: string) => Promise<void>>(
        () => Promise.resolve(),
    );
    const inbox = {
        clear: vi.fn<() => number>(() => 0),
        counts: vi.fn<() => { open: number; closed: number }>(() => ({ open: 0, closed: 0 })),
    };
    const handovers = {
        forgetClearedTasks: vi.fn<() => number>(() => 0),
        returnAllForStop: vi.fn<() => Promise<number>>(() => Promise.resolve(0)),
    };
    const onStopped = vi.fn<() => void>();
    const service = new AgentCommanderService({
        cancelRestore,
        database,
        createAndStartTerminal,
        handovers,
        inbox,
        onStopped,
        prepareLaunch,
        relaunchFresh,
        now: () => 1_000,
        probeTerminal: () => {},
        restoreTerminals,
        pullRequests: () => ({ pullRequests: {}, refreshedAt: 5 }),
        scopedWorkbench: (identity: CommanderIdentity) =>
            ({ selectedSessionId: identity.sessionId }) as BootstrapState,
        sendFullStateChange,
        sendTerminalChange,
        stopTerminal,
        userDataPath: directory,
    });
    return {
        cancelRestore,
        createAndStartTerminal,
        database,
        directory,
        handovers,
        inbox,
        onStopped,
        prepareLaunch,
        relaunchFresh,
        restoreTerminals,
        sendFullStateChange,
        sendTerminalChange,
        service,
        stopTerminal,
        terminalIdsAtStart,
        userProject,
        userSession,
    };
}
