import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readConfigDocuments, ReconciledConfigDocuments } from '../config-documents';
import type { AgentHookConfigTarget } from '../contract';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function settingsTarget(): Promise<AgentHookConfigTarget> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-documents-'));
    temporaryDirectories.push(directory);
    return { id: 'settings', path: join(directory, 'settings.json'), writable: true };
}

/**
 * The snapshot decides whether a file that became watched after the reconcile that read it needs another reconcile.
 * Missing a change loses an edit until the slow poll; reporting one that did not happen reconciles while a Terminal may
 * be launching.
 */
describe('ReconciledConfigDocuments', () => {
    it('reports a file only once it reads differently from what the reconcile saw', async () => {
        const target = await settingsTarget();
        await writeFile(target.path, '{}\n', 'utf8');
        const snapshot = new ReconciledConfigDocuments(1024);
        snapshot.remember('claude', [target], await readConfigDocuments([target], 1024));

        await expect(snapshot.changed()).resolves.toBe(false);
        await writeFile(target.path, '{ "theme": "light" }\n', 'utf8');
        await expect(snapshot.changed()).resolves.toBe(true);

        snapshot.forget('claude');
        await expect(snapshot.changed()).resolves.toBe(false);
    });

    it('treats a file created after a missing read as changed', async () => {
        const target = await settingsTarget();
        const snapshot = new ReconciledConfigDocuments(1024);
        snapshot.remember('claude', [target], await readConfigDocuments([target], 1024));

        await expect(snapshot.changed()).resolves.toBe(false);
        await writeFile(target.path, '{}\n', 'utf8');
        await expect(snapshot.changed()).resolves.toBe(true);
    });

    it('treats a file it can no longer read as changed so the reconcile reports it', async () => {
        const target = await settingsTarget();
        await writeFile(target.path, '{}\n', 'utf8');
        const snapshot = new ReconciledConfigDocuments(16);
        snapshot.remember('claude', [target], await readConfigDocuments([target], 16));

        await writeFile(target.path, `${'x'.repeat(32)}\n`, 'utf8');
        await expect(snapshot.changed()).resolves.toBe(true);
    });
});
