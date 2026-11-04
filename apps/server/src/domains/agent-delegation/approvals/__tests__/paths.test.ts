import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../../../db';
import { ProjectRootResolver } from '../../../project';
import type { WorkspacePathResolver } from '../paths';
import { pathVerdict } from '../paths';

describe('pathVerdict with a stub resolver', () => {
    const inside: WorkspacePathResolver = (_id, path) =>
        Promise.resolve({ root: '/root', workspacePath: path });

    it('has no verdict without paths', async () => {
        expect(await pathVerdict(inside, 's', undefined)).toBe('absent');
        expect(await pathVerdict(inside, 's', [])).toBe('absent');
    });

    it('proves paths under the root', async () => {
        expect(await pathVerdict(inside, 's', ['/root/a.ts', '/root/dir/b.ts'])).toBe('inside');
    });

    it('cannot vouch for a long list, a relative path, or a possibly clipped path', async () => {
        const many = Array.from({ length: 21 }, (_, index) => `/root/${index}.ts`);
        expect(await pathVerdict(inside, 's', many)).toBe('unproven');
        expect(await pathVerdict(inside, 's', ['a.ts'])).toBe('unproven');
        expect(await pathVerdict(inside, 's', [`/root/${'x'.repeat(4096)}`])).toBe('unproven');
    });

    it('calls a denied path outside and any other failure unproven', async () => {
        const denied: WorkspacePathResolver = () =>
            Promise.reject(new CaxriError('PATH_DENIED', 'outside'));
        const broken: WorkspacePathResolver = () => Promise.reject(new Error('disk'));
        expect(await pathVerdict(denied, 's', ['/root/a.ts'])).toBe('outside');
        expect(await pathVerdict(broken, 's', ['/root/a.ts'])).toBe('unproven');
    });

    it('does not trust a workspace path outside the root', async () => {
        const escaped: WorkspacePathResolver = () =>
            Promise.resolve({ root: '/root', workspacePath: '/elsewhere/a.ts' });
        const missing: WorkspacePathResolver = () => Promise.resolve({ root: '/root' });
        expect(await pathVerdict(escaped, 's', ['/root/a.ts'])).toBe('unproven');
        expect(await pathVerdict(missing, 's', ['/root/a.ts'])).toBe('unproven');
    });
});

describe('pathVerdict against the real Session root', () => {
    async function workspace() {
        const created = await mkdtemp(join(tmpdir(), 'caxri-approval-paths-'));
        const directory = await realpath(created);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        onTestFinished(async () => {
            database.close();
            await rm(directory, { recursive: true, force: true });
        });
        const root = join(directory, 'work');
        await mkdir(root);
        const project = database.createProject(root);
        const { session } = database.createSession(project.id, 'codex');
        const roots = new ProjectRootResolver(database);
        const resolve: WorkspacePathResolver = (sessionId, path) =>
            roots.resolveSessionPath(sessionId, path, true);
        return { directory, root, resolve, sessionId: session.id };
    }

    it('proves an existing file under the root and rejects a path outside it', async () => {
        const w = await workspace();
        await writeFile(join(w.root, 'a.ts'), '');
        await writeFile(join(w.directory, 'other.ts'), '');

        expect(await pathVerdict(w.resolve, w.sessionId, [join(w.root, 'a.ts')])).toBe('inside');
        expect(await pathVerdict(w.resolve, w.sessionId, [join(w.directory, 'other.ts')])).toBe(
            'outside',
        );
        expect(await pathVerdict(w.resolve, w.sessionId, [`${w.root}/../other.ts`])).toBe(
            'outside',
        );
    });

    it('never covers a write that would create a file', async () => {
        const w = await workspace();

        expect(await pathVerdict(w.resolve, w.sessionId, [join(w.root, 'missing.ts')])).toBe(
            'unproven',
        );
    });

    it('trusts a link reached through the root by its workspace entry', async () => {
        const w = await workspace();
        const target = join(w.directory, 'linked-target.ts');
        await writeFile(target, '');
        await symlink(target, join(w.root, 'link.ts'));

        expect(await pathVerdict(w.resolve, w.sessionId, [join(w.root, 'link.ts')])).toBe('inside');
        expect(await pathVerdict(w.resolve, w.sessionId, [target])).toBe('outside');
    });
});
