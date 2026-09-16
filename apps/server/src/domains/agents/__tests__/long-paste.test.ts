import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CaxriError, defaultAppSettings, MAX_LONG_PASTE_SUMMARY_CHARACTERS } from '@caxri/protocol';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { LongPasteService } from '../long-paste';
import {
    AGENT_PASTE_SUMMARY_SYSTEM_INSTRUCTIONS,
    countAgentPasteLines,
} from '../paste-summary-generation';
import type { AgentService } from '../service';

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
    hang?: boolean;
    kind?: 'codex' | 'shell';
    summary?: string | Error;
    summaryTimeoutMs?: number;
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
    const summarizePaste = vi.fn<AgentService['summarizePaste']>((_provider, context) =>
        options?.hang
            ? new Promise<string>((_resolve, reject) =>
                  context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                      once: true,
                  }),
              )
            : options?.summary instanceof Error
              ? Promise.reject(options.summary)
              : Promise.resolve(options?.summary ?? 'Compact summary'),
    );
    const agentLaunch = { current: 'launch-1' as string | undefined };
    let identifierIndex = 0;
    const service = new LongPasteService(
        userDataPath,
        database,
        { summarizePaste },
        () => settings,
        () => agentLaunch.current,
        options?.now ?? (() => Date.UTC(2026, 7, 31, 12, 34, 56)),
        () => `11111111-1111-4111-8111-${String(++identifierIndex).padStart(12, '0')}`,
        options?.summaryTimeoutMs,
        options?.cleanupIntervalMs,
    );
    services.push(service);
    return { agentLaunch, database, service, settings, summarizePaste, terminal, userDataPath };
}

describe('LongPasteService', () => {
    it('preserves native paste after a running Shell is promoted to an Agent', async () => {
        const test = await fixture({ kind: 'shell' });
        test.agentLaunch.current = undefined;
        expect(test.database.promoteShellToAgent(test.terminal.id, 'codex')).toBe(true);

        await expect(
            test.service.prepare({ terminalId: test.terminal.id, content: longPasteContent('x') }),
        ).resolves.toEqual({ status: 'passthrough' });
        expect(test.summarizePaste).not.toHaveBeenCalled();
        expect(await readdir(test.userDataPath)).not.toContain('pastes');
    });

    it('counts visual lines across common newline encodings', () => {
        expect(countAgentPasteLines('first\r\nsecond\nthird\rfourth')).toBe(4);
        expect(countAgentPasteLines('one trailing line\n')).toBe(2);
    });

    it('instructs the low-cost model to extract real log failures and discard noise', () => {
        expect(AGENT_PASTE_SUMMARY_SYSTEM_INSTRUCTIONS).toContain(
            'If the text is a log, build trace, test output, or diagnostic dump:',
        );
        expect(AGENT_PASTE_SUMMARY_SYSTEM_INSTRUCTIONS).toContain(
            'Drop timestamps, progress lines, successful steps, repeated warnings, duplicate frames, and status spam unless they are causal.',
        );
        expect(AGENT_PASTE_SUMMARY_SYSTEM_INSTRUCTIONS).toContain(
            'If no clear error or failure is present, state that explicitly rather than guessing.',
        );
    });

    it('saves text above the default threshold before returning a sanitized summary', async () => {
        const test = await fixture({ summary: 'Useful\u{1B}[31m summary\r\n- exact 42' });
        const content = `build started\r\n${longPasteContent('x')}\nError: failed`;

        const result = await test.service.prepare({ terminalId: test.terminal.id, content });

        expect(result).toMatchObject({
            characterCount: content.length,
            lineCount: 3,
            status: 'summarized',
            summary: 'Useful[31m summary\n- exact 42',
        });
        assert(result.status === 'summarized');
        expect(result.filePath).toMatch(/\/pastes\/paste-20260831T123456-/u);
        expect(await readFile(result.filePath, 'utf8')).toBe(content);
        expect((await stat(result.filePath)).mode & 0o777).toBe(0o600);
        const [provider, summaryContext] = test.summarizePaste.mock.calls[0];
        expect(provider).toBe('codex');
        expect(summaryContext.cwd).toBe(test.terminal.cwd);
        expect(summaryContext.prompt).toBe(content);
        expect(summaryContext.signal).toBeInstanceOf(AbortSignal);
    });

    it('treats the configured threshold as the largest ordinary paste', async () => {
        const test = await fixture({ threshold: 256 });

        await expect(
            test.service.prepare({ terminalId: test.terminal.id, content: 'x'.repeat(256) }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(
            test.service.prepare({ terminalId: test.terminal.id, content: 'x'.repeat(257) }),
        ).resolves.toMatchObject({ status: 'summarized' });
    });

    it('returns the saved file path without pasting the original when summary generation fails', async () => {
        const test = await fixture({ summary: new Error('provider unavailable') });
        const content = longPasteContent('private input ');

        const result = await test.service.prepare({ terminalId: test.terminal.id, content });

        expect(result).toMatchObject({ status: 'unavailable' });
        assert(result.status === 'unavailable');
        expect(await readFile(result.filePath, 'utf8')).toBe(content);
    });

    it('preserves the original paste and a content-free sandbox failure reason', async () => {
        const test = await fixture({
            summary: new CaxriError('UNAVAILABLE', 'Private native error', {
                reason: 'sandboxBoundaryConflict',
            }),
        });
        const content = longPasteContent('private fixture ');
        const result = await test.service.prepare({ terminalId: test.terminal.id, content });
        expect(result).toMatchObject({ status: 'unavailable', reason: 'sandboxBoundaryConflict' });
        assert(result.status === 'unavailable');
        expect(await readFile(result.filePath, 'utf8')).toBe(content);
        expect(JSON.stringify(result)).not.toContain('Private native error');
    });

    it('keeps astral summary text inside the wire character limit without splitting a symbol', async () => {
        const test = await fixture({
            summary: '😀'.repeat(MAX_LONG_PASTE_SUMMARY_CHARACTERS / 2),
        });

        const result = await test.service.prepare({
            terminalId: test.terminal.id,
            content: 'x'.repeat(MAX_LONG_PASTE_SUMMARY_CHARACTERS * 4 + 1),
        });

        expect(result.status).toBe('summarized');
        if (result.status !== 'summarized') return;
        expect(result.summary.length).toBe(MAX_LONG_PASTE_SUMMARY_CHARACTERS);
        expect(result.summary).toBe('😀'.repeat(MAX_LONG_PASTE_SUMMARY_CHARACTERS / 2));
    });

    it('rejects provider output that does not compress the original paste', async () => {
        const content = longPasteContent('verbatim provider echo ');
        const test = await fixture({ summary: content });

        await expect(
            test.service.prepare({ terminalId: test.terminal.id, content }),
        ).resolves.toMatchObject({ status: 'unavailable' });
    });

    it('returns the saved file path before a hanging provider can exhaust the client timeout', async () => {
        const test = await fixture({ hang: true, summaryTimeoutMs: 5 });
        const content = longPasteContent('bounded input ');

        const result = await test.service.prepare({ terminalId: test.terminal.id, content });

        expect(result).toMatchObject({ status: 'unavailable' });
        assert(result.status === 'unavailable');
        expect(await readFile(result.filePath, 'utf8')).toBe(content);
        expect(test.summarizePaste.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    });

    it('never returns an old summary to a replacement Agent process', async () => {
        const test = await fixture();
        const summary = Promise.withResolvers<string>();
        test.summarizePaste.mockImplementationOnce(() => summary.promise);
        const content = longPasteContent('generation-bound input ');

        const preparing = test.service.prepare({ terminalId: test.terminal.id, content });
        await vi.waitFor(() => expect(test.summarizePaste).toHaveBeenCalledOnce());
        test.agentLaunch.current = 'launch-2';
        summary.resolve('Stale summary');

        await expect(preparing).rejects.toMatchObject({ code: 'CONFLICT' });
        const files = await readdir(join(test.userDataPath, 'pastes'));
        expect(files).toHaveLength(1);
        expect(await readFile(join(test.userDataPath, 'pastes', files[0]), 'utf8')).toBe(content);
    });

    it('cleans expired files without requiring another paste', async () => {
        let now = Date.UTC(2026, 7, 31, 12, 34, 56);
        const test = await fixture({ cleanupIntervalMs: 5, now: () => now });
        await test.service.initialize();
        const result = await test.service.prepare({
            terminalId: test.terminal.id,
            content: longPasteContent('retention-bound input '),
        });
        assert(result.status === 'summarized');
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

    it('bounds concurrent model calls and never starts a cancelled queued summary', async () => {
        const test = await fixture();
        const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
        let active = 0;
        let maximumActive = 0;
        let gateIndex = 0;
        test.summarizePaste.mockImplementation(async () => {
            const gate = gates[gateIndex++];
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            try {
                return await gate.promise;
            } finally {
                active -= 1;
            }
        });
        const first = test.service.prepare({
            terminalId: test.terminal.id,
            content: longPasteContent('first bounded summary '),
        });
        const second = test.service.prepare({
            terminalId: test.terminal.id,
            content: longPasteContent('second bounded summary '),
        });
        await vi.waitFor(() => expect(test.summarizePaste).toHaveBeenCalledTimes(2));
        const cancellation = new AbortController();
        const third = test.service.prepare(
            {
                terminalId: test.terminal.id,
                content: longPasteContent('cancelled queued summary '),
            },
            cancellation.signal,
        );
        await vi.waitFor(async () =>
            expect(await readdir(join(test.userDataPath, 'pastes'))).toHaveLength(3),
        );
        cancellation.abort();

        await expect(third).resolves.toMatchObject({ status: 'unavailable' });
        gates[0].resolve('First summary');
        gates[1].resolve('Second summary');
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
        expect(maximumActive).toBe(2);
        expect(test.summarizePaste).toHaveBeenCalledTimes(2);
    });

    it('never starts a model call when cancellation occurs while waiting to save', async () => {
        const test = await fixture();
        const acquired = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const mutations = (
            test.service as unknown as {
                mutations: { run<T>(operation: () => Promise<T>): Promise<T> };
            }
        ).mutations;
        const holding = mutations.run(async () => {
            acquired.resolve();
            await release.promise;
        });
        await acquired.promise;
        const cancellation = new AbortController();
        const preparing = test.service.prepare(
            {
                terminalId: test.terminal.id,
                content: longPasteContent('cancelled while saving '),
            },
            cancellation.signal,
        );
        cancellation.abort();
        release.resolve();
        await holding;

        await expect(preparing).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(test.summarizePaste).not.toHaveBeenCalled();
    });

    it('rejects Shells and disabled providers before creating a file', async () => {
        const shell = await fixture({ kind: 'shell' });
        await expect(
            shell.service.prepare({
                terminalId: shell.terminal.id,
                content: longPasteContent('x'),
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(shell.summarizePaste).not.toHaveBeenCalled();

        const disabled = await fixture();
        disabled.settings['agents.providers'].codex.pasteSummary.enabled = false;
        await expect(
            disabled.service.prepare({
                terminalId: disabled.terminal.id,
                content: longPasteContent('x'),
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(disabled.summarizePaste).not.toHaveBeenCalled();
    });
});
