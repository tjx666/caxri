import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createBotSession } from '../bot';
import { CaxriDatabase } from '../db';
import type { SessionParkingOptions } from '../parking-handlers';
import { createSessionHandlers } from '../parking-handlers';
import { createBackgroundSession } from '../session';

function agentPrincipal(id: string, projectId: string) {
    return {
        kind: 'agent' as const,
        id,
        endpointId: id,
        generation: 1,
        projectIds: [projectId],
    };
}

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-session-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    await Promise.all(['bot', 'caller', 'work'].map((name) => mkdir(join(directory, name))));
    const botProject = database.createProject(join(directory, 'bot'));
    const bot = database.createSession(botProject.id, 'codex');
    database.setAppState('caxriBot', {
        projectId: botProject.id,
        sessionId: bot.session.id,
        terminalId: bot.terminal!.id,
        sessionIds: [],
    });
    const callerProject = database.createProject(join(directory, 'caller'));
    const caller = database.createSession(callerProject.id, 'codex');
    const project = database.createProject(join(directory, 'work'));
    const rename = vi.fn((sessionId: string, title: string) =>
        Promise.resolve(database.renameSession(sessionId, title)),
    );
    const handlers = createSessionHandlers(
        database,
        {
            database,
            agentChat: { closeSession: () => Promise.resolve() },
            mobileTerminalMutations: {
                runSessions: (_sessionIds: readonly string[], run: () => unknown) => run(),
            },
            terminalRestores: { cancel: vi.fn(), settled: () => Promise.resolve() },
            terminalSuspension: { suspendSession: () => Promise.resolve() },
            evictSessions: vi.fn(),
            restoreSelection: vi.fn(),
            sendFullStateChange: vi.fn(),
        } as unknown as SessionParkingOptions,
        { rename },
    );
    const manage = handlers['agent.session.manageInternal'];
    const agent = {
        principal: agentPrincipal('agent', callerProject.id),
        callerTerminalId: caller.terminal!.id,
    };
    const botAgent = {
        principal: agentPrincipal('bot', botProject.id),
        callerTerminalId: bot.terminal!.id,
    };
    return { database, manage, rename, agent, botAgent, caller, project };
}

describe('agent.session management', () => {
    it('renames, archives, and restores a Session the caller created through the sidebar flow', async () => {
        const { database, manage, rename, agent, caller, project } = await fixture();
        const sessionId = createBackgroundSession(
            database,
            project.id,
            'Review',
            caller.session.id,
        );

        await manage({ ...agent, sessionId, operation: { action: 'rename', title: 'Done' } });
        expect(rename).toHaveBeenCalledWith(sessionId, 'Done', undefined, undefined);
        await manage({ ...agent, sessionId, operation: { action: 'archive' } });
        expect(database.getSession(sessionId)?.archivedAt).toBeDefined();
        await manage({ ...agent, sessionId, operation: { action: 'unarchive' } });
        expect(database.getSession(sessionId)?.archivedAt).toBeUndefined();
    });

    it('admits another Agent of the creating Session', async () => {
        const { database, manage, agent, caller, project } = await fixture();
        const sessionId = createBackgroundSession(
            database,
            project.id,
            'Review',
            caller.session.id,
        );
        const sibling = database.createTerminal(caller.session.id, 'claude');

        await manage({
            ...agent,
            callerTerminalId: sibling.id,
            sessionId,
            operation: { action: 'archive' },
        });

        expect(database.getSession(sessionId)?.archivedAt).toBeDefined();
    });

    it.each([
        ['a Session the user created', 'user'],
        ['a Session another Session created', 'other'],
        ["the caller's own Session", 'own'],
        ['a Session in a hidden Project', 'hidden'],
    ] as const)('refuses %s as NOT_FOUND', async (_label, target) => {
        const { database, manage, agent, caller, project } = await fixture();
        const other = database.createSession(project.id, null).session.id;
        const sessionId = {
            user: () => database.createSession(project.id, null).session.id,
            other: () => createBackgroundSession(database, project.id, 'Other', other),
            own: () => caller.session.id,
            hidden: () => {
                const id = createBackgroundSession(database, project.id, 'X', caller.session.id);
                database.hideProject(project.id);
                return id;
            },
        }[target]();

        await expect(
            manage({ ...agent, sessionId, operation: { action: 'archive' } }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(database.getSession(sessionId)?.archivedAt).toBeUndefined();
    });

    it('holds Caxri Bot to the Sessions it still owns', async () => {
        const { database, manage, botAgent, project } = await fixture();
        const owned = createBotSession(database, project.id, undefined, 'Owned');
        const takenBack = createBotSession(database, project.id, undefined, 'Taken back');
        const rows = database.caxriBotRows()!;
        // Take Back removes the Session from Caxri Bot's record; its creator column still names Caxri Bot.
        database.setAppState('caxriBot', {
            projectId: rows.projectId,
            sessionId: rows.sessionId,
            terminalId: rows.terminalId,
            sessionIds: [owned],
        });

        await manage({ ...botAgent, sessionId: owned, operation: { action: 'archive' } });
        expect(database.getSession(owned)?.archivedAt).toBeDefined();
        await expect(
            manage({ ...botAgent, sessionId: takenBack, operation: { action: 'archive' } }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it("holds every Terminal in Caxri Bot's Session to Caxri Bot's ownership", async () => {
        const { database, manage, botAgent, project } = await fixture();
        const takenBack = createBotSession(database, project.id, undefined, 'Taken back');
        const rows = database.caxriBotRows()!;
        database.setAppState('caxriBot', { ...rows, sessionIds: [] });
        const leftover = database.createTerminal(rows.sessionId, 'claude');

        await expect(
            manage({
                ...botAgent,
                callerTerminalId: leftover.id,
                sessionId: takenBack,
                operation: { action: 'archive' },
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(database.getSession(takenBack)?.archivedAt).toBeUndefined();
    });
});
