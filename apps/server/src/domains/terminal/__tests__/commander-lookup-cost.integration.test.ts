import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAppSettings } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { CaxriDatabaseConnection } from '../../db';
import { CaxriDatabase } from '../../db';
import { createLifecycleEnvironment } from '../lifecycle-environment';
import { TerminalSuspensionService } from '../suspension';

/**
 * The Commander record's created-Session cap (`MAX_COMMANDER_SESSIONS` in `commander/service.ts`).
 */
const MAX_COMMANDER_SESSIONS = 1_000;

/**
 * A real database whose Commander record lists the maximum number of created Sessions, all stale. Reading the full
 * Commander rows looks each one up; the Terminal paths below only need the Commander's own identity.
 */
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-terminal-commander-cost-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const commanderProject = database.createProject(join(directory, 'commander'));
    const commanderSession = database.createSession(commanderProject.id, null).session;
    const commanderTerminal = database.createTerminal(commanderSession.id, 'codex', directory);
    const userProject = database.createProject(join(directory, 'repository'));
    const userSession = database.createSession(userProject.id, null).session;
    const userTerminal = database.createTerminal(userSession.id, 'codex', directory);
    database.setAppState('agentCommander', {
        projectId: commanderProject.id,
        sessionId: commanderSession.id,
        terminalId: commanderTerminal.id,
        sessionIds: Array.from(
            { length: MAX_COMMANDER_SESSIONS },
            (_, index) => `stale-session-${index}`,
        ),
    });
    const connection = (database as unknown as { db: CaxriDatabaseConnection }).db;
    const sessionLookups = vi.spyOn(connection.sessions, 'get');
    const staleLookups = () =>
        sessionLookups.mock.calls.filter(([id]) => id.startsWith('stale-session-')).length;
    return { commanderTerminal, database, staleLookups, userSession, userTerminal };
}

describe('Commander identity lookups on Terminal hot paths', () => {
    it('sweeps idle Terminals without a per-Session lookup of the Commander record', async () => {
        const f = await fixture();
        // Control: the full row read pays one lookup per stored Session, so the spy can see that cost.
        f.database.agentCommanderRows();
        expect(f.staleLookups()).toBe(MAX_COMMANDER_SESSIONS);
        const before = f.staleLookups();
        const service = new TerminalSuspensionService({
            database: f.database,
            logger: { write: vi.fn() } as never,
            remoteObservers: [],
            selectedSessionId: () => f.userSession.id,
            send: vi.fn(),
            settings: () => defaultAppSettings,
            terminals: {
                processId: () => {},
                settleLaunches: () => Promise.resolve(),
                suspend: vi.fn(() => Promise.resolve(undefined)),
            },
            watchHub: { registerPoller: vi.fn() as never },
        });

        await service.sweep();

        expect(f.staleLookups()).toBe(before);
    });

    it('builds an Agent launch environment, Commander role included, without a per-Session lookup', async () => {
        const f = await fixture();
        const environment = vi.fn(() => Promise.resolve({}));
        const build = createLifecycleEnvironment({
            agentHooks: { terminalEnvironment: () => ({}) },
            configuration: { getSettings: () => ({ value: defaultAppSettings }) as never },
            database: f.database,
            delegationState: {},
            endpoints: { environment, preparedEndpointForTerminal: () => true } as never,
            workbenchRoots: {} as never,
        });

        await build(f.userTerminal, {} as never, 'launch-1');
        await build(f.commanderTerminal, {} as never, 'launch-2');

        expect(environment.mock.calls.map((call) => (call as unknown[])[4])).toEqual([
            undefined,
            'commander',
        ]);
        expect(f.staleLookups()).toBe(0);
    });
});
