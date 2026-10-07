import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../../db';
import { agentProviders } from '../../providers';
import * as transcriptModule from '../../transcript';
import { SessionContentSearch } from '../service';

const THREAD = '019e676d-8740-7bb2-8bcb-f189c8260607';
const message = (provider: AgentProvider, text: string) =>
    provider === 'claude'
        ? { type: 'user', message: { content: text } }
        : provider === 'codex'
          ? {
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text }],
                },
            }
          : {
                method: 'session/update',
                params: {
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text },
                    },
                },
            };

async function fixture() {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-search-'));
    const directory = await realpath(temporaryDirectory);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const environment = { homeDirectory: directory, variables: {} };
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    async function add(provider: AgentProvider, text: string, isArchived = false) {
        const cwd = join(directory, provider);
        await mkdir(cwd, { recursive: true });
        const created = database.createSession(database.createProject(cwd).id, provider, cwd);
        const agentSessionId = provider === 'codex' ? THREAD : `synthetic-${provider}`;
        database.rebindAgentSession(created.terminal!.id, provider, agentSessionId);
        if (isArchived) database.archiveSession(created.session.id);
        let path: string;
        if (provider === 'codex') {
            const date = new Date(0x019e676d8740);
            const segments = [
                String(date.getFullYear()),
                String(date.getMonth() + 1).padStart(2, '0'),
                String(date.getDate()).padStart(2, '0'),
            ];
            path = join(
                directory,
                '.codex',
                'sessions',
                ...segments,
                `rollout-${segments.join('-')}T00-00-00-${THREAD}.jsonl`,
            );
        } else if (provider === 'grok') {
            const location = await agentProviders.grok.locateTranscript!(
                { agentSessionId, cwd },
                environment,
            );
            path = location!.path;
        } else path = agentProviders.claude.transcriptPath!({ agentSessionId, cwd }, environment)!;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(message(provider, text))}\n`);
        return { path, ...created };
    }
    return { directory, database, environment, add };
}

afterEach(() => vi.restoreAllMocks());

describe('Session content search', () => {
    it('searches all three providers across active and archived Projects without tool output', async () => {
        const f = await fixture();
        const claude = await f.add('claude', 'Discuss the shared NEEDLE');
        const codex = await f.add('codex', 'Another shared needle', true);
        const grok = await f.add('grok', 'shared nee');
        await writeFile(
            grok.path,
            `${JSON.stringify(message('grok', 'shared nee'))}\n${JSON.stringify(message('grok', 'dle'))}\n`,
        );
        await writeFile(
            claude.path,
            `${JSON.stringify(message('claude', 'Discuss the shared NEEDLE'))}\n${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'tool-only-marker' }] } })}\n`,
        );
        const service = new SessionContentSearch(f.database, f.environment);
        const result = await service.search('needle');
        expect(result).toMatchObject({ scanned: 3, total: 3, partial: false, unavailable: 0 });
        expect(
            result.matches
                .map((match) => match.sessionId)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(
            [claude.session.id, codex.session.id, grok.session.id].toSorted((left, right) =>
                left.localeCompare(right),
            ),
        );
        expect((await service.search('tool-only-marker')).matches).toEqual([]);
        expect(f.database.getSession(codex.session.id)?.archivedAt).toBeDefined();
        await writeFile(
            claude.path,
            `${JSON.stringify(message('claude', 'refreshed-cache-marker'))}\n`,
        );
        expect(
            (await service.search('refreshed-cache-marker')).matches.map(
                (match) => match.sessionId,
            ),
        ).toEqual([claude.session.id]);
    });

    it('finds a request that carried a screenshot and skips task notifications', async () => {
        const f = await fixture();
        const claude = await f.add('claude', 'placeholder');
        const screenshot = { type: 'image', source: { type: 'base64', data: 'A'.repeat(300_000) } };
        await writeFile(
            claude.path,
            `${[
                {
                    type: 'user',
                    message: {
                        content: [{ type: 'text', text: 'screenshot-request-marker' }, screenshot],
                    },
                },
                {
                    type: 'user',
                    message: {
                        content: '<task-notification>notification-marker</task-notification>',
                    },
                },
            ]
                .map((record) => JSON.stringify(record))
                .join('\n')}\n`,
        );
        const service = new SessionContentSearch(f.database, f.environment);
        expect(
            (await service.search('screenshot-request-marker')).matches.map(
                (match) => match.sessionId,
            ),
        ).toEqual([claude.session.id]);
        expect((await service.search('notification-marker')).matches).toEqual([]);
    });

    it('reports missing, unsafe and capped coverage without a false complete empty result', async () => {
        const f = await fixture();
        const created = await f.add('claude', 'a'.repeat(1000));
        const capped = await new SessionContentSearch(f.database, f.environment, {
            fileBytes: 32,
        }).search('missing');
        expect(capped).toMatchObject({ matches: [], partial: true, scanned: 1 });
        const outside = join(f.directory, 'outside.jsonl');
        await writeFile(outside, JSON.stringify(message('claude', 'forbidden-marker')));
        await rm(created.path);
        await symlink(outside, created.path);
        const refused = await new SessionContentSearch(f.database, f.environment).search(
            'forbidden-marker',
        );
        expect(refused).toMatchObject({ matches: [], partial: true, unavailable: 1, scanned: 0 });
        await rm(created.path);
        expect(
            await new SessionContentSearch(f.database, f.environment).search('missing'),
        ).toMatchObject({ partial: true, unavailable: 1 });
    });

    it('returns at the deadline while retaining slots for unfinished locators', async () => {
        const f = await fixture();
        await f.add('claude', 'synthetic');
        const pending = Promise.withResolvers<undefined>();
        const locate = vi
            .spyOn(transcriptModule, 'locateAgentTranscript')
            .mockReturnValue(pending.promise);
        const service = new SessionContentSearch(f.database, f.environment, { timeoutMs: 15 });
        const results = await Promise.all([
            service.search('one'),
            service.search('two'),
            service.search('three'),
        ]);
        expect(results.every((result) => result.partial && result.reason === 'budget')).toBe(true);
        expect(locate).toHaveBeenCalledTimes(2);
        pending.resolve(undefined);
    });

    it('cancels abandoned queries without returning their results', async () => {
        const f = await fixture();
        await f.add('claude', 'synthetic');
        const pending = Promise.withResolvers<undefined>();
        vi.spyOn(transcriptModule, 'locateAgentTranscript').mockReturnValue(pending.promise);
        const controller = new AbortController();
        const result = new SessionContentSearch(f.database, f.environment).search(
            'synthetic',
            controller.signal,
        );
        controller.abort();
        await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
        pending.resolve(undefined);
    });

    it('does not attribute a moved terminal transcript to its previous Session', async () => {
        const f = await fixture();
        const created = await f.add('claude', 'moving-marker');
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const locate = transcriptModule.locateAgentTranscript;
        vi.spyOn(transcriptModule, 'locateAgentTranscript').mockImplementationOnce(
            async (...arguments_) => {
                const location = await locate(...arguments_);
                entered.resolve();
                await resume.promise;
                return location;
            },
        );
        const service = new SessionContentSearch(f.database, f.environment);
        const searching = service.search('moving-marker');
        await entered.promise;
        const moved = f.database.moveTerminalToNewSession(created.terminal!.id);
        resume.resolve();
        expect(await searching).toMatchObject({ matches: [], partial: true, unavailable: 1 });
        expect(
            (await service.search('moving-marker')).matches.map((match) => match.sessionId),
        ).toEqual([moved.session.id]);
    });
});
