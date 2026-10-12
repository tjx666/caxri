import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalKind } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db/index';
import { createMobileSessionHandler, createSessionCreator } from '../creation';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-chat-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(directory);
    const startChat = vi.fn();
    const start = vi.fn(() => Promise.resolve());
    const observeSelectedSession = vi.fn();
    const create = createSessionCreator({
        coordinator: { prepareTerminalStart: vi.fn(), probeTerminal: vi.fn() },
        database,
        observeSelectedSession,
        sendFullStateChange: vi.fn(),
        startChat,
        terminalSuspension: { observeSelection: vi.fn() },
        terminalWorkingDirectory: ({ defaultRoot }) => Promise.resolve(defaultRoot),
        terminals: { start } as never,
    });
    return { create, database, observeSelectedSession, project, start, startChat };
}

describe('session.create with the chat surface', () => {
    it('creates a Session whose Codex Terminal is a Chat and starts no PTY', async () => {
        const { create, database, project, start, startChat } = await fixture();

        const created = await create(project.id, 'codex', 'select', undefined, 'chat');

        expect(created.terminal).toMatchObject({ kind: 'codex', surface: 'chat' });
        expect(startChat).toHaveBeenCalledWith(created.terminal!.id);
        expect(start).not.toHaveBeenCalled();
        expect(database.getSession(created.session.id)?.primaryAgentTerminalId).toBe(
            created.terminal!.id,
        );
    });

    it.each<TerminalKind | null>(['shell', null])(
        'refuses a Chat for %s without leaving an empty Session behind',
        async (kind) => {
            const { create, database, project, startChat } = await fixture();

            await expect(
                create(project.id, kind, 'select', undefined, 'chat'),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
            expect(database.listSessions()).toHaveLength(0);
            expect(startChat).not.toHaveBeenCalled();
        },
    );
});

describe('session creation for a forked Chat', () => {
    it('binds the forked Agent Session in the source cwd before the Chat starts', async () => {
        const { create, database, observeSelectedSession, project, startChat } = await fixture();
        const { session: source } = database.createSession(project.id, null);
        const sourceTerminal = database.createTerminal(source.id, 'codex', undefined, 'chat');
        database.setChatPermission(sourceTerminal.id, {
            permissionMode: 'readOnly',
            planMode: true,
        });
        // The fork keeps the source's narrower stored choice over a broader Project default.
        database.setProjectChatDefault(project.id, 'codex', { permissionMode: 'fullAccess' });
        startChat.mockImplementation((terminalId: string) => {
            expect(database.getTerminal(terminalId)?.agentSessionId).toBe('forked-thread');
        });

        const created = await create(project.id, 'codex', 'preserve', undefined, 'chat', {
            cwd: join(project.rootPath, 'nested'),
            agentSessionId: 'forked-thread',
            sourceTerminalId: sourceTerminal.id,
        });
        expect(database.getChatPermission(created.terminal!.id)).toEqual({
            permissionMode: 'readOnly',
            planMode: true,
        });

        expect(created.terminal).toMatchObject({
            cwd: join(project.rootPath, 'nested'),
            agentSessionId: 'forked-thread',
        });
        expect(startChat).toHaveBeenCalledOnce();
        expect(observeSelectedSession).not.toHaveBeenCalled();
    });
    it('keeps the Project default when the source Chat stored no permission choice', async () => {
        const { create, database, project } = await fixture();
        const { session: source } = database.createSession(project.id, null);
        const sourceTerminal = database.createTerminal(source.id, 'codex', undefined, 'chat');
        database.setProjectChatDefault(project.id, 'codex', { permissionMode: 'readOnly' });

        const created = await create(project.id, 'codex', 'preserve', undefined, 'chat', {
            cwd: project.rootPath,
            agentSessionId: undefined,
            sourceTerminalId: sourceTerminal.id,
        });
        expect(database.getChatPermission(created.terminal!.id)).toEqual({
            permissionMode: 'readOnly',
            planMode: false,
        });
    });
});

describe('mobile.session.createForPrincipal with the chat surface', () => {
    const principal = (projectId: string) => ({
        kind: 'paired-device' as const,
        id: 'device-1',
        deviceId: 'device-1',
        generation: 1,
        projectIds: [projectId],
        role: 'control' as const,
    });

    it('starts a Chat without a PTY and preserves the Desktop selection', async () => {
        const { create, database, observeSelectedSession, project, start, startChat } =
            await fixture();
        const handler = createMobileSessionHandler(database, create);

        const created = await handler({
            projectId: project.id,
            defaultAgent: 'claude',
            surface: 'chat',
            principal: principal(project.id),
        });

        expect(database.getTerminal(created.terminalId!)).toMatchObject({
            kind: 'claude',
            surface: 'chat',
        });
        expect(startChat).toHaveBeenCalledWith(created.terminalId);
        expect(start).not.toHaveBeenCalled();
        expect(observeSelectedSession).not.toHaveBeenCalled();
    });

    it('refuses a Shell Chat without leaving an empty Session behind', async () => {
        const { create, database, project, startChat } = await fixture();
        const handler = createMobileSessionHandler(database, create);

        await expect(
            handler({
                projectId: project.id,
                defaultAgent: 'shell',
                surface: 'chat',
                principal: principal(project.id),
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(database.listSessions()).toHaveLength(0);
        expect(startChat).not.toHaveBeenCalled();
    });
});
