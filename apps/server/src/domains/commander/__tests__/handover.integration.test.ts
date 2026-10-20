import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionRecord } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db';
import type { DiscoveredConversation } from '../handover';
import { CommanderHandoverService } from '../handover';
import { commanderHandoverAccess, commanderHandovers } from '../handover-records';
import { CommanderTerminalHooks } from '../terminal-hooks';

async function fixture(discovered: DiscoveredConversation[] = []) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-handover-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const commanderProject = database.createProject(join(directory, 'commander'));
    const commanderSession = database.createSession(commanderProject.id, null, undefined, {
        windowKey: 'main',
    }).session;
    const commanderTerminal = database.createTerminal(commanderSession.id, 'codex', directory);
    const repo = join(directory, 'repository');
    await mkdir(join(repo, 'packages', 'web'), { recursive: true });
    const userProject = database.createProject(repo);
    database.setAppState('agentCommander', {
        projectId: commanderProject.id,
        sessionId: commanderSession.id,
        terminalId: commanderTerminal.id,
        sessionIds: [],
    });
    /**
     * A user Session whose primary Agent holds a Codex conversation, like one started from the Workbench.
     */
    const agentSession = (conversationId = 'conversation-1') => {
        const { session, terminal } = database.createSession(userProject.id, 'codex', undefined, {
            windowKey: 'main',
        });
        database.rebindAgentSession(terminal!.id, 'codex', conversationId);
        return { session, terminal: terminal! };
    };
    /**
     * A user Session whose primary Agent is an Agent Chat, bound to `conversationId` once its provider opened one.
     */
    const chatSession = (provider: 'claude' | 'codex' | 'grok', conversationId?: string) => {
        const { session } = database.createSession(userProject.id, null, undefined, {
            windowKey: 'main',
        });
        const terminal = database.createTerminal(session.id, provider, repo, 'chat');
        if (conversationId) database.rebindAgentSession(terminal.id, provider, conversationId);
        return { session, terminal };
    };
    const notify = vi.fn();
    const logger = { write: vi.fn() };
    const sendFullStateChange = vi.fn();
    const resolveProjectRoot = vi.fn((path: string) => Promise.resolve(path));
    const service = new CommanderHandoverService({
        database,
        discoverConversations: (bound) =>
            Promise.resolve(
                discovered.filter((conversation) => !bound.has(conversation.providerSessionId)),
            ),
        logger: logger as never,
        notify,
        now: () => 50_000,
        resolveProjectRoot,
        sendFullStateChange,
    });
    return {
        agentSession,
        chatSession,
        commanderSession,
        database,
        directory,
        logger,
        notify,
        repository: repo,
        resolveProjectRoot,
        sendFullStateChange,
        service,
        userProject,
    };
}

describe('Commander hand-over', () => {
    it('hands a Session with a resumable Agent conversation to the Commander with a ledger task', async () => {
        const f = await fixture();
        const { session, terminal } = f.agentSession();

        const result = await f.service.handOver({
            sessionIds: [session.id],
            note: 'Finish the migration and open a pull request',
        });

        const [outcome] = result.outcomes;
        expect(outcome).toMatchObject({ outcome: 'accepted', sessionId: session.id });
        expect(f.service.managedSessions().sessionIds).toEqual([session.id]);
        const [handover] = commanderHandovers(f.database);
        expect(handover).toMatchObject({
            sessionId: session.id,
            source: 'session',
            target: {
                terminalId: terminal.id,
                provider: 'codex',
                providerSessionId: 'conversation-1',
            },
        });
        const task = f.database.commanderTasks.get(handover.taskId!);
        expect(task).toMatchObject({
            status: 'pending',
            sessionId: session.id,
            note: 'Finish the migration and open a pull request',
        });
        expect(f.notify).toHaveBeenCalledWith({
            event: 'ready',
            handoverId: handover.id,
            sessionId: session.id,
        });
        expect(f.sendFullStateChange).toHaveBeenCalledOnce();
    });

    it('refuses each invalid entry on its own and keeps the rest of the batch', async () => {
        const f = await fixture();
        const { session } = f.agentSession();
        const archived = f.agentSession('conversation-2').session;
        f.database.archiveSession(archived.id);
        const shellOnly = f.database.createSession(f.userProject.id, 'shell', undefined, {
            windowKey: 'main',
        }).session;

        const result = await f.service.handOver({
            sessionIds: [
                session.id,
                session.id,
                archived.id,
                f.commanderSession.id,
                'missing-session',
                shellOnly.id,
            ],
        });

        expect(result.outcomes).toEqual([
            expect.objectContaining({ outcome: 'accepted', sessionId: session.id }),
            { outcome: 'rejected', reason: 'duplicate', sessionId: session.id },
            { outcome: 'rejected', reason: 'session_archived', sessionId: archived.id },
            { outcome: 'rejected', reason: 'commander_session', sessionId: f.commanderSession.id },
            { outcome: 'rejected', reason: 'session_missing', sessionId: 'missing-session' },
            expect.objectContaining({
                outcome: 'accepted',
                sessionId: shellOnly.id,
                ownershipReason: 'agent_missing',
            }),
        ]);
        expect(f.notify).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'ownership_only', sessionId: shellOnly.id }),
        );
        const again = await f.service.handOver({ sessionIds: [session.id] });
        expect(again.outcomes).toEqual([
            { outcome: 'rejected', reason: 'already_managed', sessionId: session.id },
        ]);
    });

    it('lets the Commander continue an Agent Chat as it does a PTY Agent', async () => {
        const f = await fixture();
        const claude = f.chatSession('claude', 'claude-conversation');
        const codex = f.chatSession('codex', 'codex-thread');
        const unopened = f.chatSession('codex');

        const result = await f.service.handOver({
            sessionIds: [claude.session.id, codex.session.id, unopened.session.id],
        });

        expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual([
            'accepted',
            'accepted',
            'accepted',
        ]);
        expect(result.outcomes[2]).toMatchObject({ ownershipReason: 'provider_session_missing' });
        const targets = commanderHandovers(f.database).map((handover) => handover.target);
        expect(targets).toEqual([
            {
                terminalId: claude.terminal.id,
                provider: 'claude',
                providerSessionId: 'claude-conversation',
            },
            { terminalId: codex.terminal.id, provider: 'codex', providerSessionId: 'codex-thread' },
            undefined,
        ]);
        expect(f.notify).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'ready', sessionId: claude.session.id }),
        );
        expect(f.service.managedSessions()).toMatchObject({
            inputTakeBackSessionIds: [claude.session.id, codex.session.id],
            chatTakeBackSessionIds: [claude.session.id, codex.session.id],
        });
    });

    it('keeps a Grok Build Chat ownership-only, since its Chat cannot correlate a Commander task', async () => {
        const f = await fixture();
        const grok = f.chatSession('grok', 'grok-conversation');

        const result = await f.service.handOver({ sessionIds: [grok.session.id] });

        expect(result.outcomes).toEqual([
            expect.objectContaining({ outcome: 'accepted', ownershipReason: 'chat_surface' }),
        ]);
        expect(commanderHandovers(f.database)[0].target).toBeUndefined();
        expect(f.notify).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'ownership_only', sessionId: grok.session.id }),
        );
    });

    it('takes a Chat Session back when the user sends its Chat input', async () => {
        const f = await fixture();
        const { session, terminal } = f.chatSession('codex', 'codex-thread');
        await f.service.handOver({ sessionIds: [session.id] });
        const hooks = new CommanderTerminalHooks(f.database, f.logger as never);
        hooks.handovers = f.service;

        hooks.chatInput(terminal.id);

        expect(f.service.managedSessions()).toMatchObject({
            sessionIds: [],
            inputTakeBacks: [expect.objectContaining({ sessionId: session.id }) as unknown],
        });
        expect(commanderHandovers(f.database)).toEqual([]);
    });

    it('refuses everything while the Commander was never set up', async () => {
        const f = await fixture();
        const { session } = f.agentSession();
        vi.spyOn(f.database, 'agentCommanderRows').mockReturnValue(undefined);

        const result = await f.service.handOver({ sessionIds: [session.id] });

        expect(result.outcomes).toEqual([
            { outcome: 'rejected', reason: 'commander_unavailable', sessionId: session.id },
        ]);
    });

    it('waits for a busy Agent to finish its turn before announcing it ready', async () => {
        const f = await fixture();
        const { session, terminal } = f.agentSession();
        f.database.updateAgentProcessState(terminal.id, 'running');
        const getSession = f.database.getSession.bind(f.database);
        let activity: SessionRecord['lastActivityState'] = 'running';
        vi.spyOn(f.database, 'getSession').mockImplementation((id) => {
            const current = getSession(id);
            return current && { ...current, lastActivityState: activity };
        });

        await f.service.handOver({ sessionIds: [session.id] });
        expect(f.notify).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'busy' }));

        f.service.onLifecycleApplied({ terminalId: terminal.id });
        expect(f.notify).toHaveBeenCalledOnce();
        activity = 'completed';
        f.service.onLifecycleApplied({ terminalId: terminal.id });
        expect(f.notify).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'ready' }));
        expect(f.notify).toHaveBeenCalledTimes(2);
        expect(commanderHandoverAccess(f.database).isBusy(session.id, terminal.id)).toBe(false);
    });

    it('takes the Session back when the user types into its Agent, and only then', async () => {
        const f = await fixture();
        const { session, terminal } = f.agentSession();
        const other = f.agentSession('conversation-2');
        const accepted = (await f.service.handOver({ sessionIds: [session.id] })).outcomes[0];
        if (accepted.outcome !== 'accepted') throw new Error('hand-over was refused');

        f.service.observeInput(other.terminal.id);
        const commanderSessionId = f.database.agentCommanderRows()?.sessionId;
        expect(f.service.managedSessions()).toEqual({
            sessionIds: [session.id],
            commanderSessionId,
            inputTakeBackSessionIds: [session.id],
            chatTakeBackSessionIds: [],
            inputTakeBacks: [],
        });

        f.service.observeInput(terminal.id);
        expect(f.service.managedSessions()).toEqual({
            sessionIds: [],
            commanderSessionId,
            inputTakeBackSessionIds: [],
            chatTakeBackSessionIds: [],
            // The Workbench reads this to tell the user a keystroke took the Session back.
            inputTakeBacks: [
                { id: expect.any(String) as unknown, sessionId: session.id, at: 50_000 },
            ],
        });
        expect(commanderHandovers(f.database)).toEqual([]);
        // The never-continued hand-over's task closes instead of holding a ledger slot.
        expect(f.database.commanderTasks.get(accepted.taskId!)).toMatchObject({
            status: 'dropped',
        });
        expect(f.logger.write).toHaveBeenCalledWith(
            'info',
            'agent_commander.session_taken_back',
            expect.objectContaining({
                fields: expect.objectContaining({
                    sessionId: session.id,
                    reason: 'human_input',
                }) as unknown,
            }),
        );
        expect(f.service.takeBack(session.id)).toEqual({
            sessionId: session.id,
            outcome: 'not_managed',
        });
    });

    it('reports only take-backs caused by typing, never an explicit one', async () => {
        const f = await fixture();
        const { session } = f.agentSession();
        await f.service.handOver({ sessionIds: [session.id] });

        expect(f.service.takeBack(session.id).outcome).toBe('taken_back');

        expect(f.service.managedSessions().inputTakeBacks).toEqual([]);
    });

    it('lets the Commander continue a hand-over exactly once and links its task', async () => {
        const f = await fixture();
        const { session, terminal } = f.agentSession();
        const result = await f.service.handOver({ sessionIds: [session.id] });
        const accepted = result.outcomes[0];
        if (accepted.outcome !== 'accepted') throw new Error('hand-over was refused');
        const access = commanderHandoverAccess(f.database, undefined, () => 60_000);

        expect(access.target(accepted.handoverId, session.id)).toEqual({
            terminalId: terminal.id,
            provider: 'codex',
            providerSessionId: 'conversation-1',
        });
        expect(() => access.target(accepted.handoverId, 'another-session')).toThrow(
            'Hand-over is unavailable',
        );
        access.consume(accepted.handoverId, 'delegation-1');

        expect(() => access.target(accepted.handoverId, session.id)).toThrow('already continued');
        expect(f.database.commanderTasks.get(accepted.taskId!)).toMatchObject({
            delegationId: 'delegation-1',
            status: 'dispatched',
        });
        f.notify.mockClear();
        f.service.requeue();
        expect(f.notify).not.toHaveBeenCalled();
    });

    it('forgets a hand-over the Commander has not continued once its task is deleted', async () => {
        const f = await fixture();
        const { session, terminal } = f.agentSession();
        const continued = f.agentSession('conversation-2');
        const [pending, started] = (
            await f.service.handOver({ sessionIds: [session.id, continued.session.id] })
        ).outcomes;
        if (pending.outcome !== 'accepted' || started.outcome !== 'accepted')
            throw new Error('hand-over was refused');
        commanderHandoverAccess(f.database).consume(started.handoverId, 'delegation-1');
        expect(f.service.forgetClearedTasks()).toBe(0);

        f.database.commanderTasks.delete('all');
        f.notify.mockClear();

        expect(f.service.forgetClearedTasks()).toBe(1);
        expect(commanderHandovers(f.database).map((handover) => handover.id)).toEqual([
            started.handoverId,
        ]);
        f.service.requeue();
        expect(f.notify).not.toHaveBeenCalled();
        expect(() =>
            commanderHandoverAccess(f.database).target(pending.handoverId, session.id),
        ).toThrow('Hand-over is unavailable');
        // Typing no longer takes it back: the Session stays the Commander's, like after any deleted task.
        f.service.observeInput(terminal.id);
        expect(f.service.managedSessions().sessionIds).toEqual([session.id, continued.session.id]);
    });

    it('re-announces every hand-over the Commander has not continued before it launches', async () => {
        const f = await fixture();
        const { session } = f.agentSession();
        const shellOnly = f.database.createSession(f.userProject.id, 'shell', undefined, {
            windowKey: 'main',
        }).session;
        await f.service.handOver({ sessionIds: [session.id, shellOnly.id] });
        f.notify.mockClear();

        f.service.requeue();

        expect(f.notify).toHaveBeenCalledOnce();
        expect(f.notify).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'ready', sessionId: session.id }),
        );
    });

    it('imports an external conversation into a parked Session of the Project that contains it', async () => {
        const providerSessionId = '0b7c5a52-6f1e-4c55-9f0a-2d0f6f0d6a11';
        const f = await fixture();
        const cwd = join(f.repository, 'packages', 'web');
        const conversation: DiscoveredConversation = {
            provider: 'claude',
            providerSessionId,
            cwd,
            title: 'Tidy the web package',
            updatedAt: 40_000,
            mayBeOpen: false,
        };
        const service = new CommanderHandoverService({
            database: f.database,
            discoverConversations: (bound) =>
                Promise.resolve(bound.has(providerSessionId) ? [] : [conversation]),
            notify: f.notify,
            resolveProjectRoot: f.resolveProjectRoot,
            sendFullStateChange: f.sendFullStateChange,
        });
        expect((await service.conversations()).conversations).toEqual([
            { ...conversation, projectId: f.userProject.id },
        ]);

        const result = await service.handOver({
            conversations: [
                { provider: 'claude', providerSessionId },
                { provider: 'codex', providerSessionId: 'never-seen' },
            ],
        });

        const [accepted, missing] = result.outcomes;
        expect(missing).toEqual({
            outcome: 'rejected',
            reason: 'conversation_missing',
            conversation: { provider: 'codex', providerSessionId: 'never-seen' },
        });
        if (accepted.outcome !== 'accepted') throw new Error('conversation was refused');
        const session = f.database.getSession(accepted.sessionId)!;
        expect(session).toMatchObject({
            projectId: f.userProject.id,
            displayTitle: 'Tidy the web package',
        });
        const [terminal] = f.database.listTerminals(session.id);
        expect(terminal).toMatchObject({
            kind: 'claude',
            cwd,
            agentSessionId: providerSessionId,
            lastProcessState: 'detached',
        });
        expect(f.database.windowOpenSessions.get('main').activeSessionId).not.toBe(session.id);
        expect(commanderHandovers(f.database)[0]).toMatchObject({
            source: 'conversation',
            target: { terminalId: terminal.id, provider: 'claude' },
        });
        expect(f.resolveProjectRoot).not.toHaveBeenCalled();
        const repeated = await service.handOver({
            conversations: [{ provider: 'claude', providerSessionId }],
        });
        expect(repeated.outcomes[0]).toMatchObject({ reason: 'conversation_bound' });
    });

    it('adds the folder of an external conversation as a Project when none contains it', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'caxri-commander-outside-'));
        onTestFinished(() => rm(outside, { recursive: true, force: true }));
        const f = await fixture([
            {
                provider: 'codex',
                providerSessionId: 'conversation-outside',
                cwd: outside,
                updatedAt: 40_000,
                mayBeOpen: true,
            },
        ]);

        expect((await f.service.conversations()).conversations[0].projectId).toBeNull();

        const result = await f.service.handOver({
            conversations: [{ provider: 'codex', providerSessionId: 'conversation-outside' }],
        });

        expect(result.outcomes[0]).toMatchObject({ outcome: 'accepted' });
        expect(f.resolveProjectRoot).toHaveBeenCalledWith(outside);
        expect(f.database.findProjectByRootPath(outside)).toBeDefined();
    });

    it('records one hand-over when the same Session is handed over again while discovery is pending', async () => {
        const f = await fixture();
        const { session } = f.agentSession();
        const discovering = Promise.withResolvers<DiscoveredConversation[]>();
        const service = new CommanderHandoverService({
            database: f.database,
            discoverConversations: () => discovering.promise,
            notify: f.notify,
            resolveProjectRoot: f.resolveProjectRoot,
            sendFullStateChange: f.sendFullStateChange,
        });

        const slow = service.handOver({
            sessionIds: [session.id],
            conversations: [{ provider: 'codex', providerSessionId: 'never-seen' }],
        });
        const fast = await service.handOver({ sessionIds: [session.id] });
        discovering.resolve([]);
        const late = await slow;

        expect(fast.outcomes).toEqual([
            expect.objectContaining({ outcome: 'accepted', sessionId: session.id }),
        ]);
        expect(late.outcomes).toContainEqual({
            outcome: 'rejected',
            reason: 'already_managed',
            sessionId: session.id,
        });
        expect(commanderHandovers(f.database)).toHaveLength(1);
        expect(f.database.commanderTasks.countOpen()).toBe(1);
        expect(service.managedSessions().sessionIds).toEqual([session.id]);
    });

    it('matches a conversation reached through a symlinked folder to the Project that contains it', async () => {
        const f = await fixture();
        const root = await realpath(join(f.directory, 'repository'));
        const project = f.database.findProjectByRootPath(root) ?? f.database.createProject(root);
        const alias = join(f.directory, 'repository-alias');
        await symlink(join(root, 'packages'), alias);
        const providerSessionId = 'conversation-through-alias';
        const conversation: DiscoveredConversation = {
            provider: 'codex',
            providerSessionId,
            cwd: join(alias, 'web'),
            updatedAt: 40_000,
            mayBeOpen: false,
        };
        const service = new CommanderHandoverService({
            database: f.database,
            discoverConversations: (bound) =>
                Promise.resolve(bound.has(providerSessionId) ? [] : [conversation]),
            notify: f.notify,
            resolveProjectRoot: f.resolveProjectRoot,
            sendFullStateChange: f.sendFullStateChange,
        });
        const projectsBefore = f.database.listVisibleProjects().length;

        expect((await service.conversations()).conversations).toEqual([
            { ...conversation, projectId: project.id },
        ]);
        const result = await service.handOver({
            conversations: [{ provider: 'codex', providerSessionId }],
        });

        const [accepted] = result.outcomes;
        if (accepted.outcome !== 'accepted') throw new Error('conversation was refused');
        expect(f.database.getSession(accepted.sessionId)?.projectId).toBe(project.id);
        expect(f.resolveProjectRoot).not.toHaveBeenCalled();
        expect(f.database.listVisibleProjects()).toHaveLength(projectsBefore);
    });
});
