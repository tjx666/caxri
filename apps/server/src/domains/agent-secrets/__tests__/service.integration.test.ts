import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { SECRET_REQUEST_ABANDON_MS, SECRET_REQUEST_LIFETIME_MS } from '../requests';
import { AgentSecretService } from '../service';
import { AGENT_SECRETS_FILE } from '../store';

const SYNTHETIC_VALUE = 'synthetic-secret-value';
const caller = { projectId: 'project-a', terminalId: 'terminal-a' };

describe('AgentSecretService', () => {
    let directory: string;
    let projects: Set<string>;
    let events: ServerEvent[];
    let write: ReturnType<typeof vi.fn>;
    let now: number;
    let service: AgentSecretService;

    function create(): AgentSecretService {
        return new AgentSecretService({
            database: {
                getProject: (id: string) =>
                    id === 'worktree-a'
                        ? { id, ownerProjectId: 'project-a' }
                        : projects.has(id)
                          ? { id }
                          : undefined,
                getTerminal: (id: string) =>
                    id === caller.terminalId ? { id, sessionId: 'session-a' } : undefined,
            } as unknown as Pick<CaxriDatabase, 'getProject' | 'getTerminal'>,
            logger: { write } as unknown as StructuredLogger,
            send: (event) => events.push(event),
            userDataPath: directory,
            now: () => now,
        });
    }

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'caxri-agent-secrets-'));
        projects = new Set(['project-a', 'project-b']);
        events = [];
        write = vi.fn();
        now = 1_000;
        service = create();
    });

    afterEach(async () => {
        service.close();
        await rm(directory, { recursive: true, force: true });
    });

    it('lets a Project secret override a global one and hides other Projects', async () => {
        await service.set('API_TOKEN', { kind: 'global' }, 'global-value');
        await service.set('API_TOKEN', { kind: 'project', projectId: 'project-a' }, 'a-value');
        await service.set('OTHER', { kind: 'project', projectId: 'project-b' }, 'b-value');

        await expect(service.visible(caller)).resolves.toEqual({
            secrets: [{ name: 'API_TOKEN', scope: 'project' }],
        });
        await expect(service.resolve({ caller, names: ['API_TOKEN'] })).resolves.toEqual({
            values: { API_TOKEN: 'a-value' },
        });
        const missing = service.resolve({ caller, names: ['OTHER'] });
        await expect(missing).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(missing).rejects.toThrow('caxri secret request OTHER');
    });

    it('shares a Project secret with the worktree Projects it owns', async () => {
        await service.set('API_TOKEN', { kind: 'project', projectId: 'project-a' }, 'a-value');

        await expect(
            service.resolve({
                caller: { projectId: 'worktree-a', terminalId: 'terminal-a' },
                names: ['API_TOKEN'],
            }),
        ).resolves.toEqual({ values: { API_TOKEN: 'a-value' } });
    });

    it('stores values in an owner-only file that survives a restart, and never logs them', async () => {
        await service.set('API_TOKEN', { kind: 'global' }, SYNTHETIC_VALUE);
        const file = join(directory, AGENT_SECRETS_FILE);
        expect((await stat(file)).mode & 0o777).toBe(0o600);

        service.close();
        service = create();
        await expect(service.resolve({ caller, names: ['API_TOKEN'] })).resolves.toEqual({
            values: { API_TOKEN: SYNTHETIC_VALUE },
        });
        expect(JSON.stringify(write.mock.calls)).not.toContain(SYNTHETIC_VALUE);
        expect(JSON.stringify(write.mock.calls)).not.toContain('API_TOKEN');
        expect(JSON.stringify(events)).not.toContain(SYNTHETIC_VALUE);
    });

    it('refuses a damaged store instead of replacing it', async () => {
        const file = join(directory, AGENT_SECRETS_FILE);
        await writeFile(file, '{ not json');

        await expect(service.set('API_TOKEN', { kind: 'global' }, 'x')).rejects.toMatchObject({
            code: 'IO',
        });
        await expect(readFile(file, 'utf8')).resolves.toBe('{ not json');
    });

    it('answers a request with the saved value and its scope', async () => {
        const request = await service.request({ caller, name: 'API_TOKEN', reason: 'Deploy' });
        expect(request).toMatchObject({ status: 'pending' });
        if (request.status !== 'pending') return;
        const again = await service.request({ caller, name: 'API_TOKEN', reason: 'Deploy' });
        expect(again).toEqual(request);
        expect(service.requests.pending()).toHaveLength(1);

        const waiting = service.wait({ caller, requestId: request.requestId, timeoutMs: 5_000 });
        await expect(
            service.answer({
                requestId: request.requestId,
                answer: { action: 'save', value: SYNTHETIC_VALUE, scope: 'project' },
            }),
        ).resolves.toEqual({ status: 'saved' });
        await expect(waiting).resolves.toEqual({ status: 'saved' });
        await expect(service.list()).resolves.toEqual([
            {
                name: 'API_TOKEN',
                scope: { kind: 'project', projectId: 'project-a' },
                updatedAt: 1_000,
            },
        ]);
        await expect(
            service.request({ caller, name: 'API_TOKEN', reason: 'Deploy' }),
        ).resolves.toEqual({ status: 'available' });
    });

    it('settles a pending request when the user saves the same name from Settings', async () => {
        const request = await service.request({ caller, name: 'API_TOKEN', reason: 'Deploy' });
        if (request.status !== 'pending') throw new Error('expected a pending request');

        await service.set('API_TOKEN', { kind: 'project', projectId: 'project-b' }, 'b-value');
        expect(service.requests.get(request.requestId)?.status).toBe('pending');
        await service.set('API_TOKEN', { kind: 'global' }, 'global-value');
        expect(service.requests.get(request.requestId)?.status).toBe('saved');
    });

    it('keeps a request private to the Terminal that raised it', async () => {
        const request = await service.request({ caller, name: 'API_TOKEN', reason: 'Deploy' });
        if (request.status !== 'pending') throw new Error('expected a pending request');

        await expect(
            service.wait({
                caller: { projectId: 'project-a', terminalId: 'terminal-b' },
                requestId: request.requestId,
                timeoutMs: 100,
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('withdraws a request nobody polls and expires one nobody answers', async () => {
        const abandoned = await service.request({ caller, name: 'ONE', reason: 'Deploy' });
        if (abandoned.status !== 'pending') throw new Error('expected a pending request');
        now += SECRET_REQUEST_ABANDON_MS;
        service.requests.sweep();
        await expect(
            service.wait({ caller, requestId: abandoned.requestId, timeoutMs: 100 }),
        ).resolves.toEqual({ status: 'cancelled' });

        const unanswered = await service.request({ caller, name: 'TWO', reason: 'Deploy' });
        if (unanswered.status !== 'pending') throw new Error('expected a pending request');
        for (let elapsed = 0; elapsed < SECRET_REQUEST_LIFETIME_MS; elapsed += 60_000) {
            now += 60_000;
            // A live Agent keeps polling, so the request is never abandoned, only expired.
            // eslint-disable-next-line no-await-in-loop -- each poll happens at a later clock reading.
            await service.wait({ caller, requestId: unanswered.requestId, timeoutMs: 100 });
            service.requests.sweep();
        }
        expect(service.requests.get(unanswered.requestId)?.status).toBe('expired');
        await expect(
            service.answer({ requestId: unanswered.requestId, answer: { action: 'decline' } }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('drops the secrets of a deleted Project and keeps global ones', async () => {
        await service.set('API_TOKEN', { kind: 'global' }, 'global-value');
        await service.set('API_TOKEN', { kind: 'project', projectId: 'project-b' }, 'b-value');
        projects.delete('project-b');

        await service.pruneDeletedProjects();

        await expect(service.list()).resolves.toEqual([
            { name: 'API_TOKEN', scope: { kind: 'global' }, updatedAt: 1_000 },
        ]);
    });
});
