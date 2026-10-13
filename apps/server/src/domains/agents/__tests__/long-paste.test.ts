import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAppSettings, MAX_LONG_PASTE_BYTES } from '@caxri/protocol';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { countAgentPasteLines, LongPasteService } from '../long-paste';

/**
 * Keeps every case above the shipped default threshold without restating its value, so a change to
 * `terminal.longPasteThreshold`'s default cannot silently turn these cases into ordinary passthroughs.
 */
function longPasteContent(seed: string): string {
    return seed.repeat(
        Math.ceil((defaultAppSettings['terminal.longPasteThreshold'] + 1) / seed.length),
    );
}

const temporaryDirectories: string[] = [];
const databases: CaxriDatabase[] = [];
const services: LongPasteService[] = [];

afterEach(async () => {
    for (const service of services) service.close();
    services.length = 0;
    const pendingDatabases = [...databases];
    databases.length = 0;
    for (const database of pendingDatabases) database.close();
    const pendingDirectories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture(options?: {
    kind?: 'codex' | 'shell';
    threshold?: number;
    cleanupIntervalMs?: number;
    now?: () => number;
}) {
    const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-long-paste-'));
    temporaryDirectories.push(userDataPath);
    const database = new CaxriDatabase(join(userDataPath, 'state.db'));
    databases.push(database);
    const project = database.createProject(userDataPath);
    const terminal = database.createSession(project.id, options?.kind ?? 'codex').terminal!;
    database.updateTerminalState(terminal.id, 'running');
    if (terminal.kind !== 'shell') database.updateAgentProcessState(terminal.id, 'running');
    const settings = structuredClone(defaultAppSettings);
    if (options?.threshold !== undefined)
        settings['terminal.longPasteThreshold'] = options.threshold;
    const agentLaunch = { current: 'launch-1' as string | undefined };
    let identifierIndex = 0;
    const service = new LongPasteService(
        userDataPath,
        database,
        () => settings,
        () => agentLaunch.current,
        options?.now ?? (() => Date.UTC(2026, 7, 31, 12, 34, 56)),
        () => `11111111-1111-4111-8111-${String(++identifierIndex).padStart(12, '0')}`,
        options?.cleanupIntervalMs,
    );
    services.push(service);
    return { agentLaunch, database, service, settings, terminal, userDataPath };
}

/**
 * Lets a test occupy the file-mutation semaphore so it can change state while a paste is provably mid-save.
 */
function holdMutations(service: LongPasteService) {
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const mutations = (
        service as unknown as { mutations: { run<T>(operation: () => Promise<T>): Promise<T> } }
    ).mutations;
    const holding = mutations.run(async () => {
        acquired.resolve();
        await release.promise;
    });
    return { acquired: acquired.promise, holding, release };
}

describe('LongPasteService', () => {
    it('rejects UTF-8 content above the shared budget before creating a paste file', async () => {
        const test = await fixture();
        const content = '界'.repeat(Math.floor(MAX_LONG_PASTE_BYTES / 3) + 1);
        await expect(
            test.service.prepare({ terminalId: test.terminal.id, content }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(await readdir(test.userDataPath)).not.toContain('pastes');
    });
    it('saves text beyond the former protocol and local file limits intact', async () => {
        const test = await fixture();
        const content = 'x'.repeat(5 * 1024 * 1024);
        const result = await test.service.prepare({ terminalId: test.terminal.id, content });
        assert(result.status === 'saved');
        expect(await readFile(result.filePath, 'utf8')).toBe(content);
        expect(result.characterCount).toBe(content.length);
    });

    it('preserves native paste after a running Shell is promoted to an Agent', async () => {
        const test = await fixture({ kind: 'shell' });
        test.agentLaunch.current = undefined;
        expect(test.database.promoteShellToAgent(test.terminal.id, 'codex')).toBe(true);

        await expect(
            test.service.prepare({ terminalId: test.terminal.id, content: longPasteContent('x') }),
        ).resolves.toEqual({ status: 'passthrough' });
        expect(await readdir(test.userDataPath)).not.toContain('pastes');
    });

    it('counts visual lines across common newline encodings', () => {
        expect(countAgentPasteLines('first\r\nsecond\nthird\rfourth')).toBe(4);
        expect(countAgentPasteLines('one trailing line\n')).toBe(2);
    });

    it('saves text above the default threshold to an owner-only file and reports its size', async () => {
        const test = await fixture();
        const content = `build started\r\n${longPasteContent('x')}\nError: failed`;

        const result = await test.service.prepare({ terminalId: test.terminal.id, content });

        expect(result).toMatchObject({
            agentLaunchId: 'launch-1',
            characterCount: content.length,
            lineCount: 3,
            status: 'saved',
        });
        assert(result.status === 'saved');
        expect(result.filePath).toMatch(/\/pastes\/paste-20260831T123456-/u);
        expect(await readFile(result.filePath, 'utf8')).toBe(content);
        expect((await stat(result.filePath)).mode & 0o777).toBe(0o600);
    });

    it('treats the configured threshold as the largest ordinary paste', async () => {
        const test = await fixture({ threshold: 256 });

        await expect(
            test.service.prepare({ terminalId: test.terminal.id, content: 'x'.repeat(256) }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(
            test.service.prepare({ terminalId: test.terminal.id, content: 'x'.repeat(257) }),
        ).resolves.toMatchObject({ status: 'saved' });
    });

    it('never hands a saved file to a replacement Agent process', async () => {
        const test = await fixture();
        const content = longPasteContent('generation-bound input ');
        const hold = holdMutations(test.service);
        await hold.acquired;

        const preparing = test.service.prepare({ terminalId: test.terminal.id, content });
        test.agentLaunch.current = 'launch-2';
        hold.release.resolve();
        await hold.holding;

        await expect(preparing).rejects.toMatchObject({ code: 'CONFLICT' });
        const files = await readdir(join(test.userDataPath, 'pastes'));
        expect(files).toHaveLength(1);
        expect(await readFile(join(test.userDataPath, 'pastes', files[0]), 'utf8')).toBe(content);
    });

    it('reports cancellation that arrives while the paste is still being saved', async () => {
        const test = await fixture();
        const hold = holdMutations(test.service);
        await hold.acquired;
        const cancellation = new AbortController();

        const preparing = test.service.prepare(
            { terminalId: test.terminal.id, content: longPasteContent('cancelled while saving ') },
            cancellation.signal,
        );
        cancellation.abort();
        hold.release.resolve();
        await hold.holding;

        await expect(preparing).rejects.toMatchObject({ code: 'CANCELLED' });
    });

    it('cleans expired files without requiring another paste', async () => {
        let now = Date.UTC(2026, 7, 31, 12, 34, 56);
        const test = await fixture({ cleanupIntervalMs: 5, now: () => now });
        await test.service.initialize();
        const result = await test.service.prepare({
            terminalId: test.terminal.id,
            content: longPasteContent('retention-bound input '),
        });
        assert(result.status === 'saved');
        /**
         * The filesystem owns mtime, so advance the injected clock from the persisted file instead of a fixed date.
         */
        now = (await stat(result.filePath)).mtimeMs + 31 * 24 * 60 * 60 * 1_000;

        await vi.waitFor(async () => {
            let isExists = true;
            try {
                await stat(result.filePath);
            } catch {
                isExists = false;
            }
            expect(isExists).toBe(false);
        });
    });

    it('rejects a Shell before creating a file', async () => {
        const shell = await fixture({ kind: 'shell' });

        await expect(
            shell.service.prepare({
                terminalId: shell.terminal.id,
                content: longPasteContent('x'),
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await readdir(shell.userDataPath)).not.toContain('pastes');
    });

    it('saves a Chat paste to the shared directory without needing a PTY Agent', async () => {
        const test = await fixture();
        test.database.terminalSurfaces.switch(test.terminal.id, 'chat');
        // A Chat decides for itself when text is long, so even a short paste is saved as asked.
        const content = 'first line\nsecond line';

        const result = await test.service.saveForChat({ terminalId: test.terminal.id, content });

        expect(result).toMatchObject({ characterCount: content.length, lineCount: 2 });
        expect(result.filePath).toMatch(/\/pastes\/paste-20260831T123456-/u);
        expect(await readFile(result.filePath, 'utf8')).toBe(content);
        expect((await stat(result.filePath)).mode & 0o777).toBe(0o600);
    });

    it('refuses a Chat paste for a PTY Terminal or one past the shared budget', async () => {
        const test = await fixture();
        await expect(
            test.service.saveForChat({ terminalId: test.terminal.id, content: 'text' }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        test.database.terminalSurfaces.switch(test.terminal.id, 'chat');
        const tooLarge = '界'.repeat(Math.floor(MAX_LONG_PASTE_BYTES / 3) + 1);
        await expect(
            test.service.saveForChat({ terminalId: test.terminal.id, content: tooLarge }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(readdir(join(test.userDataPath, 'pastes'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });
});
