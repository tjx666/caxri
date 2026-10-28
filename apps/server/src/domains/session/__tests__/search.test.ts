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
        }),
    );
    const inspect = vi.fn();
    const onSessionImported = vi.fn();
    const service = new SessionSearchService({
        database,
        index: { search, inspect },
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
        repo,
        search,
        service,
    };
}

describe('SessionSearchService', () => {
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
