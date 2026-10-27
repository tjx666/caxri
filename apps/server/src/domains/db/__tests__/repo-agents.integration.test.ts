import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_TERMINAL_TITLE_LENGTH } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../repository';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

/**
 * Facade-level coverage for the Agent-owned half of `CaxriDatabase`: metadata synchronization, attention epochs, the
 * conversation-title source, and the Agent's reported working directory. Session, Project, Terminal, and pane-layout
 * behavior lives in `./repo.integration.test.ts`.
 */
describe('CaxriDatabase Agent metadata', () => {
    it('synchronizes default Agent metadata into the Session and Terminal records', async () => {
        const directory = await temporaryDirectory('caxri-db-agent-metadata-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(root).id, 'codex');

        expect(
            database.updateAgentMetadata(created.terminal!.id, {
                provider: 'codex',
                available: true,
                observedAt: Date.now(),
                sessionId: 'agent-session-1',
                status: 'running',
                title: 'Implement Agent metadata',
            }),
        ).toBe(true);
        expect(database.getSession(created.session.id)).toMatchObject({
            title: 'Implement Agent metadata',
            agentActivityState: 'running',
        });
        expect(database.getTerminal(created.terminal!.id)).toMatchObject({
            agentSessionId: 'agent-session-1',
        });

        database.updateTerminalExitState(created.terminal!.id, 'stopped');
        expect(database.getSession(created.session.id)?.agentActivityState).toBe('completed');

        const restartedAt = Date.now() + 1;
        database.resetAgentMetadataForStart(created.terminal!.id, restartedAt);
        expect(database.getTerminal(created.terminal!.id)).toMatchObject({
            agentSessionId: undefined,
            updatedAt: restartedAt,
        });
        expect(database.getSession(created.session.id)).toMatchObject({
            title: 'Implement Agent metadata',
            agentActivityState: 'completed',
        });
        database.close();
    });

    it('persists reliable primary-Agent attention and acknowledges only the current epoch', async () => {
        const directory = await temporaryDirectory('caxri-db-session-attention-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const created = database.createSession(database.createProject(directory).id, 'claude');

        expect(database.getSession(created.session.id)).toMatchObject({
            attentionGeneration: 0,
            acknowledgedAttentionGeneration: 0,
            hasUnread: false,
        });
        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'claude',
            available: true,
            observedAt: Date.now(),
            status: 'running',
        });
        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'claude',
            attentionKind: 'waiting',
            available: true,
            observedAt: Date.now(),
            status: 'waiting',
            title: 'Needs input',
        });
        expect(database.getSession(created.session.id)).toMatchObject({
            attentionGeneration: 1,
            acknowledgedAttentionGeneration: 0,
            lastAttentionKind: 'waiting',
            hasUnread: true,
        });

        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'claude',
            attentionKind: 'waiting',
            available: true,
            observedAt: Date.now(),
            status: 'waiting',
            title: 'Still needs input',
        });
        expect(database.getSession(created.session.id)?.attentionGeneration).toBe(1);
        expect(database.markSessionAttentionRead(created.session.id, 1)).toMatchObject({
            acknowledged: true,
            session: { hasUnread: false, acknowledgedAttentionGeneration: 1 },
        });

        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'claude',
            available: true,
            observedAt: Date.now(),
            status: 'running',
        });
        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'claude',
            attentionKind: 'completed',
            available: true,
            observedAt: Date.now(),
            status: 'completed',
        });
        expect(database.markSessionAttentionRead(created.session.id, 1)).toMatchObject({
            acknowledged: false,
            session: {
                attentionGeneration: 2,
                hasUnread: true,
                acknowledgedAttentionGeneration: 1,
            },
        });
        expect(database.markSessionAttentionRead(created.session.id, 2)).toMatchObject({
            acknowledged: true,
            session: {
                attentionGeneration: 2,
                hasUnread: false,
                acknowledgedAttentionGeneration: 2,
            },
        });

        database.updateTerminalState(created.terminal!.id, 'running');
        database.markShutdown('orderly');
        expect(database.getSession(created.session.id)).toMatchObject({
            attentionGeneration: 2,
            hasUnread: false,
            acknowledgedAttentionGeneration: 2,
        });

        database.archiveSession(created.session.id);
        database.close();
        const reopened = new CaxriDatabase(databasePath);
        expect(reopened.unarchiveSessions([created.session.id])[0]).toMatchObject({
            attentionGeneration: 2,
            acknowledgedAttentionGeneration: 2,
            lastAttentionKind: 'completed',
            hasUnread: false,
        });
        reopened.close();
    });

    it('marks the finished turn read when the Agent starts another turn on its own', async () => {
        const directory = await temporaryDirectory('caxri-db-turn-supersedes-unread-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const lifecycle = (phase: 'turnFinished' | 'turnStarted') =>
            database.updateAgentLifecycle({
                launchId: 'launch-1',
                phase,
                provider: 'claude',
                terminalId: created.terminal!.id,
            });

        lifecycle('turnStarted');
        lifecycle('turnFinished');
        expect(database.getSession(created.session.id)).toMatchObject({
            attentionGeneration: 1,
            hasUnread: true,
            agentActivityState: 'completed',
        });

        // A background shell finishing resumes Claude Code without the user opening the Session.
        expect(lifecycle('turnStarted')).toBe(true);
        expect(database.getSession(created.session.id)).toMatchObject({
            attentionGeneration: 1,
            hasUnread: false,
            agentActivityState: 'running',
            acknowledgedAttentionGeneration: 1,
        });

        lifecycle('turnFinished');
        expect(database.getSession(created.session.id)).toMatchObject({
            attentionGeneration: 2,
            hasUnread: true,
            agentActivityState: 'completed',
        });
        database.close();
    });

    it('promotes the first Agent Terminal in a Shell Session as its title source', async () => {
        const directory = await temporaryDirectory('caxri-db-primary-agent-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(root).id, 'shell');
        const codex = database.createTerminal(created.session.id, 'codex');
        const claude = database.createTerminal(created.session.id, 'claude');

        expect(database.getSession(created.session.id)).toMatchObject({
            title: 'Untitled',
            primaryAgentTerminalId: codex.id,
        });
        database.updateAgentMetadata(codex.id, {
            provider: 'codex',
            available: true,
            observedAt: Date.now(),
            sessionId: 'codex-session-1',
            status: 'running',
            title: 'Run the development server',
        });
        expect(database.getSession(created.session.id)?.title).toBe('Run the development server');

        database.updateAgentMetadata(claude.id, {
            provider: 'claude',
            available: true,
            observedAt: Date.now(),
            sessionId: 'claude-session-1',
            status: 'running',
            title: 'Do not replace the first Agent title',
        });
        expect(database.getSession(created.session.id)?.title).toBe('Run the development server');
        // The Session title belongs to the primary Agent alone, but every Agent Terminal's own tab names its own
        // conversation: a secondary Agent must not be left reading "Claude".
        expect(database.getTerminal(claude.id)?.title).toBe('Do not replace the first Agent title');
        expect(database.getTerminal(codex.id)?.title).toBe('Run the development server');
        database.close();
    });

    it('names an Agent Terminal by its conversation and clears it for a fresh start', async () => {
        const directory = await temporaryDirectory('caxri-db-agent-title-ownership-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, null);
        const terminal = database.createTerminal(created.session.id, 'shell');

        // A plain Shell is titled by its own OSC 0/2 stream, which lands in the separate live column.
        expect(database.setTerminalPtyTitle(terminal.id, '~/project')).toBe(true);
        expect(database.getTerminal(terminal.id)).toMatchObject({
            ptyTitle: '~/project',
            title: 'Shell',
        });

        database.promoteShellToAgent(terminal.id, 'codex', {
            provider: 'codex',
            available: true,
            observedAt: Date.now(),
            sessionId: 'codex-session-1',
            status: 'running',
            title: 'Ship the release notes',
        });
        expect(database.getTerminal(terminal.id)?.title).toBe('Ship the release notes');

        /**
         * This direct repository call deliberately bypasses the production OSC listener to verify the low-level column
         * separation. The listener discards Agent-bound OSC before this provider-agnostic setter; even a direct write
         * here must not touch the conversation name shown for an Agent Terminal (`terminalDisplayTitle`).
         */
        expect(database.setTerminalPtyTitle(terminal.id, '~/project')).toBe(true);
        expect(database.getTerminal(terminal.id)?.title).toBe('Ship the release notes');

        // A restart binds a brand new conversation; inheriting the retired one's name would misname it indefinitely.
        database.resetAgentMetadataForStart(terminal.id);
        expect(database.getTerminal(terminal.id)?.title).toBe('Codex');
        database.close();
    });

    /**
     * @see https://github.com/tjx666/caxri/issues/575
     */
    it('records a diverged Agent working directory without touching the authorized launch root', async () => {
        const directory = await temporaryDirectory('caxri-db-agent-cwd-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const terminal = created.terminal!;
        const worktree = join(directory, '..', 'worktree');

        expect(database.setTerminalAgentCwd(terminal.id, 'claude', worktree)).toBe(true);
        expect(database.getTerminal(terminal.id)).toMatchObject({
            agentCwd: worktree,
            cwd: terminal.cwd,
        });

        // Repeating the same proven divergence is inert.
        expect(database.setTerminalAgentCwd(terminal.id, 'claude', worktree)).toBe(false);
        // A report attributed to another provider cannot rewrite this Terminal's divergence.
        expect(database.setTerminalAgentCwd(terminal.id, 'codex', join(directory, 'other'))).toBe(
            false,
        );
        expect(database.getTerminal(terminal.id)?.agentCwd).toBe(worktree);

        expect(database.setTerminalAgentCwd(terminal.id, 'claude', undefined)).toBe(true);
        expect(database.getTerminal(terminal.id)?.agentCwd).toBeUndefined();
        database.close();
    });

    it('clears a diverged Agent working directory when a replacement Agent starts', async () => {
        const directory = await temporaryDirectory('caxri-db-agent-cwd-restart-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const terminal = created.terminal!;
        database.setTerminalAgentCwd(terminal.id, 'claude', join(directory, '..', 'worktree'));

        // The replacement process starts in the launch root, so the retired process's worktree must not survive.
        database.resetAgentMetadataForStart(terminal.id);

        expect(database.getTerminal(terminal.id)?.agentCwd).toBeUndefined();
        database.close();
    });

    it('caps an Agent conversation title at the length the Host will accept back', async () => {
        const directory = await temporaryDirectory('caxri-db-agent-title-length-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const terminal = created.terminal!;

        database.updateAgentMetadata(terminal.id, {
            provider: 'codex',
            available: true,
            observedAt: Date.now(),
            sessionId: 'codex-session-1',
            status: 'running',
            title: 'x'.repeat(500),
        });

        /**
         * `Terminal.title` is replayed as `agentEndpoint.begin.name` on the next launch, where the Server schema caps
         * it at 200 characters and rejects the whole request otherwise: an over-long conversation name would fail the
         * Agent's next start rather than just look wrong.
         */
        const title = database.getTerminal(terminal.id)?.title ?? '';
        expect(title.length).toBeLessThanOrEqual(MAX_TERMINAL_TITLE_LENGTH);
        expect(title).toBe('x'.repeat(MAX_TERMINAL_TITLE_LENGTH));
        database.close();
    });

    /**
     * A rename that reaches no further than Caxri's own database: a provider without native rename, or an Agent that
     * has not produced a session yet: used to leave the tab on the Agent's conversation name indefinitely, because no
     * later metadata probe would ever carry the typed name. The sidebar row and the tab then showed one Session under
     * two different names.
     */
    it('retitles the primary Agent Terminal with the Session it belongs to', async () => {
        const directory = await temporaryDirectory('caxri-db-rename-agent-tab-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const primary = created.terminal!;
        const secondary = database.createTerminal(created.session.id, 'claude');

        database.updateAgentMetadata(primary.id, {
            provider: 'codex',
            available: true,
            observedAt: Date.now(),
            sessionId: 'codex-session-1',
            status: 'running',
            title: 'Resume unfinished work',
        });
        expect(database.getTerminal(primary.id)?.title).toBe('Resume unfinished work');

        database.renameSession(created.session.id, 'Trace the router logs');

        expect(database.getSession(created.session.id)).toMatchObject({
            title: 'Trace the router logs',
            primaryAgentTerminalId: primary.id,
        });
        expect(database.getTerminal(primary.id)?.title).toBe('Trace the router logs');
        // A secondary Agent's tab is the only thing naming that conversation, so the Session's name is not its own.
        expect(database.getTerminal(secondary.id)?.title).toBe('Claude');
        database.close();
    });

    /**
     * The Session title is bounded at 200 characters and this path is also reached automatically with a provider's own
     * thread name, so the tab bound has to be applied here rather than assumed. A Terminal title over
     * `MAX_TERMINAL_TITLE_LENGTH` is replayed as `agentEndpoint.begin.name` on the next launch and rejected there.
     */
    it('holds a renamed Agent tab to the Terminal title bound', async () => {
        const directory = await temporaryDirectory('caxri-db-rename-agent-tab-bound-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const primary = created.terminal!;

        database.renameSession(created.session.id, 'y'.repeat(180));

        expect(database.getSession(created.session.id)?.title).toBe('y'.repeat(180));
        expect(database.getTerminal(primary.id)?.title).toBe('y'.repeat(MAX_TERMINAL_TITLE_LENGTH));
        database.close();
    });

    it('keeps Untitled while promoting an Agent Terminal before metadata arrives', async () => {
        const directory = await temporaryDirectory('caxri-db-primary-agent-succession-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const claude = database.createTerminal(created.session.id, 'claude');

        database.closeTerminal(created.terminal!.id);

        expect(database.getSession(created.session.id)).toMatchObject({
            title: 'Untitled',
            primaryAgentTerminalId: claude.id,
        });
        database.close();
    });
});
