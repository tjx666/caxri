import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Principal, ServerEvent, TerminalRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { vi } from 'vitest';

import type { AgentEndpointLifecycle } from '../../agent-endpoints';
import type { AgentCoordinator } from '../../agents';
import { CaxriDatabase } from '../../db';
import type { TerminalManager, TerminalWorkingDirectoryIdentity } from '../../terminal';
import { AgentDispatchService } from '../service';

export const PRINCIPAL: Principal = { kind: 'human-cli', id: 'human-cli:test' };

/**
 * Every directory {@link openDatabase} created, newest last; tests root their Project at `.at(-1)`.
 */
export const temporaryDirectories: string[] = [];
const databases: CaxriDatabase[] = [];
const services: AgentDispatchService[] = [];

/**
 * Closes services before their databases so pending waits settle against an open receipt table.
 */
export async function closeDispatchFixtures(): Promise<void> {
    for (const service of services) service.close();
    services.length = 0;
    for (const database of databases) database.close();
    databases.length = 0;
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
}

export async function openDatabase(): Promise<CaxriDatabase> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-dispatch-service-'));
    temporaryDirectories.push(directory);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    databases.push(database);
    return database;
}

export function fakeTerminals(database: CaxriDatabase) {
    const processIds = new Map<string, number>();
    const agentProcessIds = new Map<string, number>();
    const markRunning = (terminalId: string): TerminalRecord => {
        database.updateTerminalState(terminalId, 'running');
        database.updateAgentProcessState(terminalId, 'running');
        agentProcessIds.set(terminalId, 5_242);
        return database.getTerminal(terminalId)!;
    };
    return {
        agentLaunchId: () => 'synthetic-launch',
        agentProcessId: (terminalId: string) => agentProcessIds.get(terminalId),
        processId: (terminalId: string) => processIds.get(terminalId),
        start: (terminal: TerminalRecord) => {
            processIds.set(terminal.id, 4_242);
            return Promise.resolve(markRunning(terminal.id));
        },
        restart: (terminalId: string) => {
            processIds.set(terminalId, 4_243);
            return Promise.resolve(markRunning(terminalId));
        },
        signalAgentExact: vi.fn(() => true),
        waitForAgentRunning: vi.fn(() => Promise.resolve()),
    } as unknown as TerminalManager;
}

export function createService(
    database: CaxriDatabase,
    terminals: TerminalManager = fakeTerminals(database),
    endpoints: AgentEndpointLifecycle = {
        endpointForTerminal: (terminalId: string) => ({
            launchId: `launch-${terminalId}`,
            terminalId,
            ref: {
                hostId: 'host-1',
                endpointId: `endpoint-${terminalId}`,
                generation: 1,
            },
        }),
    } as AgentEndpointLifecycle,
    logger: StructuredLogger = { write: vi.fn() } as never,
    terminalDirectoryIdentity: (path: string) => Promise<TerminalWorkingDirectoryIdentity> = (
        path,
    ) => Promise.resolve({ device: '1', inode: '1', path }),
    emit: (event: ServerEvent) => void = vi.fn(),
) {
    const service = new AgentDispatchService({
        logger,
        database,
        coordinator: {
            prepareTerminalStart: vi.fn(),
            prepareTerminalResume: vi.fn(),
            probeTerminal: vi.fn(),
        } as unknown as AgentCoordinator,
        terminals,
        endpoints,
        launchSettings: () => ({ executable: '/fixture/codex', args: [] }),
        terminalDirectoryIdentity,
        terminalWorkingDirectory: ({ defaultRoot }) => Promise.resolve(defaultRoot),
        emit,
    });
    services.push(service);
    return service;
}

export async function seededDispatch() {
    const database = await openDatabase();
    const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
    const { session } = database.createSession(project.id, 'shell');
    const service = createService(database);
    return { database, project, service, session };
}
