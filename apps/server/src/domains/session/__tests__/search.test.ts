import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { IndexedConversationHit, IndexSearchRequest, IndexSearchResponse } from '../../agents';
import { SessionSearchIndexUnavailableError } from '../../agents';
import { CaxriDatabase } from '../../db';
import { SessionSearchService } from '../search';

const HELD = '019a0000-0000-7000-8000-00000000a001';
const ARCHIVED = '019a0000-0000-7000-8000-00000000a002';
const EXTERNAL = '019a0000-0000-7000-8000-00000000a003';

function hit(agentSessionId: string, overrides: Partial<IndexedConversationHit> = {}) {
    return {
        key: `codex:${agentSessionId}`,
        provider: 'codex',
        agentSessionId,
        title: `Indexed ${agentSessionId.slice(-4)}`,
        cwd: '/workspace/indexed',
        updatedAt: 1_000,
        field: 'content',
        snippet: { role: 'user', text: 'invoice rounding', highlights: [[0, 7]] },
        messageCount: 2,
        score: 5,
        ...overrides,
    } satisfies IndexedConversationHit;
}

async function fixture(
    hits: IndexedConversationHit[] = [],
    options: Pick<
        ConstructorParameters<typeof SessionSearchService>[0],
        'internalRoots' | 'readTopology'
    > = {},
) {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-session-search-'));
    const directory = await realpath(temporary);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const repo = join(directory, 'billing');
    await mkdir(repo, { recursive: true });
    const project = database.createProject(repo);
    const open = database.createSession(project.id, 'codex');
    database.rebindAgentSession(open.terminal!.id, 'codex', HELD);
    database.renameSession(open.session.id, 'Fix invoice rounding');
    const archived = database.createSession(project.id, 'codex');
    database.rebindAgentSession(archived.terminal!.id, 'codex', ARCHIVED);
    database.archiveSession(archived.session.id);
    const search = vi.fn<(request: IndexSearchRequest) => Promise<IndexSearchResponse>>(() =>
        Promise.resolve({
            hits,
            status: { state: 'ready', conversations: hits.length, pending: 0 },
            usedSubstringScan: false,
            relaxation: 'phrase',
        }),
    );
    const inspect = vi.fn();
    const preview = vi.fn();
    const onSessionImported = vi.fn();
    const service = new SessionSearchService({
        database,
        index: { search, inspect, preview },
        resolveProjectRoot: (path) => Promise.resolve(path),
        onSessionImported,
        ...options,
    });
    return {
        archived,
        database,
        directory,
        inspect,
        onSessionImported,
        open,
        preview,
        repo,
        search,
        service,
    };
}

describe('SessionSearchService', () => {
    it('previews an external conversation from the index without creating a Session', async () => {
        const f = await fixture();
        const window = {
            messages: [],
            matchCount: 0,
            matchIndex: 0,
            hasEarlier: false,
            hasLater: false,
        };
        f.preview.mockResolvedValue(window);
        const before = f.database.listVisibleSessions().length;

        await expect(
            f.service.preview({ provider: 'codex', agentSessionId: EXTERNAL, query: 'invoice' }),
        ).resolves.toEqual(window);

        expect(f.database.listVisibleSessions()).toHaveLength(before);
        expect(f.inspect).not.toHaveBeenCalled();
        expect(f.onSessionImported).not.toHaveBeenCalled();
    });

    it('reports an unavailable index as UNAVAILABLE', async () => {
        const f = await fixture();
        f.preview.mockRejectedValue(new SessionSearchIndexUnavailableError());

        await expect(
            f.service.preview({ provider: 'codex', agentSessionId: EXTERNAL, query: '' }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('hands the index the query without operators and reports the parsed filters', async () => {
        const f = await fixture();

        const result = await f.service.search({
            query: 'invoice agent:codex project:Billing before:2026-10-01 after:2026-09-01',
        });

        expect(f.search).toHaveBeenCalledWith(
            expect.objectContaining({
                query: 'invoice',
                providers: ['codex'],
                projects: ['billing'],
                beforeMs: new Date(2026, 9, 1).getTime(),
                afterMs: new Date(2026, 8, 1).getTime(),
            }),
            undefined,
        );
        expect(result.filters).toEqual({
            agents: ['codex'],
            projects: ['billing'],
            before: '2026-10-01',
            after: '2026-09-01',
        });
        expect(result.relaxation).toBe('phrase');
    });

    it('narrows the providers parameter by the agent operator and searches nothing when they are disjoint', async () => {
        const f = await fixture();

        await f.service.search({ query: 'agent:codex', providers: ['codex', 'claude'] });
        expect(f.search).toHaveBeenLastCalledWith(
            expect.objectContaining({ providers: ['codex'] }),
            undefined,
        );

        f.search.mockClear();
        const result = await f.service.search({ query: 'agent:grok', providers: ['codex'] });
        expect(f.search).not.toHaveBeenCalled();
        expect(result.entries).toEqual([]);
        expect(result.filters.agents).toEqual(['grok']);
    });

    it('filters Session titles by project folder and date window', async () => {
        const f = await fixture();

        const inProject = await f.service.search({ query: 'invoice project:billing' });
        const elsewhere = await f.service.search({ query: 'invoice project:nowhere' });
        const longAgo = await f.service.search({ query: 'invoice before:2000-01-01' });

        expect(inProject.entries.map((entry) => entry.sessionId)).toEqual([f.open.session.id]);
        expect(elsewhere.entries).toEqual([]);
        expect(longAgo.entries).toEqual([]);
    });

    it('ranks the current Project ahead of a newer match elsewhere and passes its root to the index', async () => {
        const f = await fixture([hit(EXTERNAL, { score: 9, field: 'title', cwd: '/elsewhere' })]);
        const otherRoot = join(f.directory, 'other');
        await mkdir(otherRoot, { recursive: true });
        const other = f.database.createProject(otherRoot);
        const session = f.database.createSession(other.id, 'codex');
        f.database.renameSession(session.session.id, 'Invoice in another Project');

        const withHint = await f.service.search({
            query: 'invoice',
            currentProjectId: f.open.session.projectId,
        });
        const withoutHint = await f.service.search({ query: 'invoice' });

        expect(f.search).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ preferredRoot: f.repo }),
            undefined,
        );
        // The other Project's Session is newer, so without the hint it leads.
        expect(withoutHint.entries[0].sessionId).toBe(session.session.id);
        expect(withHint.entries[0].sessionId).toBe(f.open.session.id);
        expect(withHint.entries[0].isCurrentProject).toBe(true);
        expect(withHint.entries[1].isCurrentProject).toBeUndefined();
        expect(withoutHint.entries.some((entry) => entry.isCurrentProject)).toBe(false);
    });

    it('relaxes to any word on a Session title when the index holds nothing', async () => {
        const f = await fixture();

        const result = await f.service.search({ query: 'invoice zebra' });

        expect(result.relaxation).toBe('anyWord');
        expect(result.entries.map((entry) => entry.sessionId)).toEqual([f.open.session.id]);
    });

    it('applies the date window to the Session a conversation belongs to', async () => {
        const f = await fixture([hit(HELD, { updatedAt: Date.parse('2026-09-01T00:00:00Z') })]);

        const result = await f.service.search({ query: 'rounding before:2026-10-01' });

        // The conversation is old, but its Session was active just now, so it is outside the window.
        expect(result.entries.map((entry) => entry.agentSessionId)).toEqual([]);
    });

    it('strips operators from the preview query', async () => {
        const f = await fixture();
        f.preview.mockResolvedValue({
            messages: [],
            matchCount: 0,
            matchIndex: 0,
            hasEarlier: false,
            hasLater: false,
        });

        await f.service.preview({
            provider: 'codex',
            agentSessionId: EXTERNAL,
            query: 'agent:codex invoice',
        });

        expect(f.preview).toHaveBeenCalledWith(
            expect.objectContaining({ query: 'invoice' }),
            undefined,
        );
    });

    it('reports a held conversation as its Session and the rest as external', async () => {
        const f = await fixture([
            hit(EXTERNAL, { score: 9 }),
            hit(HELD),
            hit(ARCHIVED, { score: 1 }),
        ]);

        const result = await f.service.search({ query: 'invoice' });

        expect(
            result.entries.map(({ status, sessionId, agentSessionId, title }) => ({
                status,
                sessionId,
                agentSessionId,
                title,
            })),
        ).toEqual([
            // The open Session's own title matches, which outranks every message match.
            {
                status: 'open',
                sessionId: f.open.session.id,
                agentSessionId: HELD,
                title: 'Fix invoice rounding',
            },
            {
                status: 'external',
                sessionId: undefined,
                agentSessionId: EXTERNAL,
                title: 'Indexed a003',
            },
            {
                status: 'archived',
                sessionId: f.archived.session.id,
                agentSessionId: ARCHIVED,
                title: f.archived.session.title,
            },
        ]);
        expect(result.entries[1].match).toMatchObject({ field: 'content', messageCount: 2 });
    });

    it('turns the status filter into index restrictions', async () => {
        const f = await fixture();

        await f.service.search({ query: 'x', status: 'external' });
        await f.service.search({ query: 'x', status: 'archived' });

        // Key order follows the holdings map, which is not part of the contract.
        const restrictions = f.search.mock.calls.map(([{ restrict }]) => ({
            mode: restrict?.mode,
            keys: restrict?.keys.toSorted((left, right) => left.localeCompare(right)),
        }));
        expect(restrictions).toEqual([
            { mode: 'exclude', keys: [`codex:${HELD}`, `codex:${ARCHIVED}`] },
            { mode: 'include', keys: [`codex:${ARCHIVED}`] },
        ]);
    });

    it('still finds Caxri Sessions by title when the index is unavailable', async () => {
        const f = await fixture();
        f.search.mockRejectedValueOnce(new SessionSearchIndexUnavailableError());

        const result = await f.service.search({ query: 'rounding' });

        expect(result.index.state).toBe('unavailable');
        expect(result.entries.map((entry) => entry.sessionId)).toEqual([f.open.session.id]);
    });

    it('adds an external conversation as a parked Session in its Project', async () => {
        const f = await fixture();
        f.inspect.mockResolvedValue({ cwd: f.repo, title: 'Ship the refund ledger', updatedAt: 1 });

        const imported = await f.service.importConversation('claude', EXTERNAL);

        const session = f.database.getSession(imported.sessionId)!;
        // The transcript's title is only a starting point: naming the conversation later may still replace it.
        expect(session).toMatchObject({
            projectId: f.open.session.projectId,
            title: 'Ship the refund ledger',
            titleMode: 'automatic',
        });
        const terminal = f.database.listTerminals().find((row) => row.sessionId === session.id)!;
        expect(terminal).toMatchObject({ provider: 'claude', agentSessionId: EXTERNAL });
        expect(f.onSessionImported).toHaveBeenCalledOnce();
        // A conversation already held answers with its Session instead of a second one.
        expect(await f.service.importConversation('codex', HELD)).toEqual({
            sessionId: f.open.session.id,
            projectId: f.open.session.projectId,
        });
    });

    it('refuses a conversation whose folder is gone', async () => {
        const f = await fixture();
        f.inspect.mockResolvedValue({ cwd: join(f.directory, 'deleted'), updatedAt: 1 });

        await expect(f.service.importConversation('claude', EXTERNAL)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        expect(f.onSessionImported).not.toHaveBeenCalled();
    });

    it("keeps conversations in Caxri's own Agent folders out of search and import", async () => {
        const bot = '/profile/caxri-bot';
        const f = await fixture(
            [hit(EXTERNAL, { cwd: `${bot}/tasks` }), hit(ARCHIVED, { cwd: bot }), hit(HELD)],
            { internalRoots: [bot] },
        );

        const result = await f.service.search({ query: 'invoice' });

        // A Session holding the conversation still lists it; only unheld ones in the folder are hidden.
        expect(result.entries.map((entry) => entry.agentSessionId)).toEqual([HELD, ARCHIVED]);
        f.inspect.mockResolvedValue({ cwd: bot, updatedAt: 1 });
        await expect(f.service.importConversation('claude', EXTERNAL)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });

    it('places a conversation run in a linked worktree under the Project that owns it', async () => {
        const readTopology = vi.fn();
        const f = await fixture([], { readTopology });
        const root = join(f.directory, 'billing-worktrees', 'feature');
        const cwd = join(root, 'packages');
        await mkdir(cwd, { recursive: true });
        readTopology.mockResolvedValue({
            repositoryKey: join(f.repo, '.git'),
            worktrees: [
                { branch: 'main', rootPath: f.repo, isMain: true },
                { branch: 'feature', rootPath: root },
            ],
        });
        f.inspect.mockResolvedValue({ cwd, updatedAt: 1 });

        const imported = await f.service.importConversation('claude', EXTERNAL);

        const session = f.database.getSession(imported.sessionId)!;
        expect(session).toMatchObject({ projectId: f.open.session.projectId, rootPath: root });
        expect(f.database.getProject(session.workbenchRootProjectId)).toMatchObject({
            rootPath: root,
            ownerProjectId: f.open.session.projectId,
        });
        const terminal = f.database.listTerminals().find((row) => row.sessionId === session.id)!;
        expect(terminal.cwd).toBe(cwd);
    });

    it('keeps a worktree the user added as its own Project', async () => {
        const readTopology = vi.fn();
        const f = await fixture([], { readTopology });
        const root = join(f.directory, 'billing-worktrees', 'feature');
        await mkdir(root, { recursive: true });
        const added = f.database.createProject(root);
        f.inspect.mockResolvedValue({ cwd: root, updatedAt: 1 });

        const imported = await f.service.importConversation('claude', EXTERNAL);

        expect(imported.projectId).toBe(added.id);
        expect(readTopology).not.toHaveBeenCalled();
    });
});
