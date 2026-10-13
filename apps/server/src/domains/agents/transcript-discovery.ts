import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';

import type { AgentEnvironment } from './contract';
import { isOpaqueAgentSessionId } from './contract';
import { agentProviders } from './providers';
import { resolveCodexHome } from './providers/codex/paths';
import { parseCodexRolloutName } from './providers/codex/rollouts';
import { grokHome } from './providers/grok/paths';
import type { AgentTranscriptLocation } from './transcript-security';
import { openSafeAgentTranscript } from './transcript-security';

/**
 * Bounds one discovery pass. A heavy Codex user writes a few hundred rollouts a day, so this covers years of history;
 * past it the newest-first walk stops instead of stalling the report.
 */
const MAX_TRANSCRIPTS = 50_000;
/**
 * Entries read from any one directory; matches the Codex day-folder budget.
 */
const MAX_DIRECTORY_ENTRIES = 8_192;
/**
 * Claude names its working directory on the first records and Codex on the first one (`session_meta`), whose base
 * instructions can run to tens of kilobytes before the next record.
 */
const CWD_HEAD_BYTES = 256 * 1024;
const MAX_GROK_CWD_BYTES = 16_384;
/**
 * The record-level `"cwd"` key. A literal inside string content is escaped (`\"cwd\":\"`), so only a record's own key
 * matches.
 */
const CWD_PATTERN = /"cwd":"((?:[^"\\]|\\.){1,4096})"/;
const UUID_FILE_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.jsonl$/i;

/**
 * One transcript file found on this machine, whether or not Caxri hosted its conversation.
 */
export interface DiscoveredTranscript {
    provider: AgentProvider;
    /**
     * Unique per file: the Agent Session ID, or the rollout ID of a reverted Codex thread's continuation.
     */
    transcriptId: string;
    agentSessionId: string;
    main: AgentTranscriptLocation;
    /**
     * Known from the layout itself (Grok names its directory after the cwd); otherwise read from the transcript.
     */
    cwd?: string;
    /**
     * The file continues a conversation another file already holds; see `UsageParserOptions.isContinuation`.
     */
    isContinuation: boolean;
}

interface DirectoryEntry {
    name: string;
    isDirectory: boolean;
    isFile: boolean;
}

async function listDirectory(directory: string): Promise<DirectoryEntry[]> {
    const entries: DirectoryEntry[] = [];
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
        handle = await opendir(directory);
        for await (const entry of handle) {
            entries.push({
                name: entry.name,
                isDirectory: entry.isDirectory(),
                isFile: entry.isFile(),
            });
            if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
        }
    } catch {
        // A missing directory is an empty one.
    } finally {
        try {
            await handle?.close();
        } catch {
            // Async iteration already closes an exhausted handle.
        }
    }
    return entries;
}

/**
 * Names of the subdirectories of `directory`, newest first for date-named folders.
 */
async function subdirectories(directory: string): Promise<string[]> {
    const entries = await listDirectory(directory);
    return entries
        .filter((entry) => entry.isDirectory)
        .map((entry) => entry.name)
        .toSorted((a, b) => b.localeCompare(a));
}

async function fileNames(directory: string): Promise<string[]> {
    const entries = await listDirectory(directory);
    return entries.filter((entry) => entry.isFile).map((entry) => entry.name);
}

async function claudeTranscriptsIn(baseRoot: string, directory: string) {
    const root = join(baseRoot, directory);
    const names = await fileNames(root);
    return names
        .filter((name) => UUID_FILE_PATTERN.test(name))
        .map((name): DiscoveredTranscript => {
            const agentSessionId = basename(name, '.jsonl');
            return {
                provider: 'claude',
                transcriptId: agentSessionId,
                agentSessionId,
                main: { baseRoot, root, path: join(root, name) },
                isContinuation: false,
            };
        });
}

/**
 * `<config>/projects/<encoded cwd>/<session id>.jsonl`. Subagent side files live one level deeper and belong to their
 * main transcript.
 */
async function discoverClaude(environment: AgentEnvironment): Promise<DiscoveredTranscript[]> {
    const baseRoot = agentProviders.claude.transcriptBaseRoot?.(environment);
    if (!baseRoot) return [];
    const directories = await subdirectories(baseRoot);
    const found: DiscoveredTranscript[] = [];
    for (const directory of directories)
        // eslint-disable-next-line no-await-in-loop -- one directory at a time bounds open handles
        found.push(...(await claudeTranscriptsIn(baseRoot, directory)));
    return found;
}

async function codexRolloutsIn(
    root: string,
    location: Pick<AgentTranscriptLocation, 'anchorRoot' | 'baseRoot'>,
): Promise<DiscoveredTranscript[]> {
    const names = await fileNames(root);
    return names.flatMap((name) => {
        const rollout = parseCodexRolloutName(name);
        if (!rollout) return [];
        return [
            {
                provider: 'codex' as const,
                transcriptId: rollout.rolloutId,
                agentSessionId: rollout.threadId,
                main: { ...location, root, path: join(root, name) },
                isContinuation: rollout.rolloutId !== rollout.threadId,
            },
        ];
    });
}

/**
 * Day folders under `sessions/YYYY/MM/DD`, newest first, each with the month folder the safe transcript reader treats
 * as its base.
 */
async function codexDayFolders(
    sessionsRoot: string,
): Promise<Array<{ baseRoot: string; root: string }>> {
    const days: Array<{ baseRoot: string; root: string }> = [];
    const years = await subdirectories(sessionsRoot);
    for (const year of years) {
        // eslint-disable-next-line no-await-in-loop -- one directory at a time bounds open handles
        const months = await subdirectories(join(sessionsRoot, year));
        for (const month of months) {
            const baseRoot = join(sessionsRoot, year, month);
            // eslint-disable-next-line no-await-in-loop -- one directory at a time bounds open handles
            const names = await subdirectories(baseRoot);
            days.push(...names.map((day) => ({ baseRoot, root: join(baseRoot, day) })));
        }
    }
    return days;
}

/**
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` plus the flat `archived_sessions` folder Codex moves archived
 * threads into. Walked newest first so the transcript budget drops the oldest history. Every file is its own entry: a
 * reverted thread's `<thread>_<rollout>` continuation sits beside the original rollout it continues.
 */
async function discoverCodex(environment: AgentEnvironment): Promise<DiscoveredTranscript[]> {
    const codexHome = resolveCodexHome(environment);
    const sessionsRoot = join(codexHome, 'sessions');
    const found: DiscoveredTranscript[] = [];
    const days = await codexDayFolders(sessionsRoot);
    for (const { baseRoot, root } of days) {
        if (found.length >= MAX_TRANSCRIPTS) return found;
        // eslint-disable-next-line no-await-in-loop -- one directory at a time bounds open handles
        found.push(...(await codexRolloutsIn(root, { anchorRoot: sessionsRoot, baseRoot })));
    }
    const archived = await codexRolloutsIn(join(codexHome, 'archived_sessions'), {
        baseRoot: codexHome,
    });
    return [...found, ...archived];
}

/**
 * Grok names a session directory after its percent-encoded cwd, or after a hash with the cwd in a `.cwd` marker when
 * the encoded name would exceed a path segment.
 */
async function grokDirectoryCwd(directory: string, name: string): Promise<string | undefined> {
    let handle: FileHandle | undefined;
    try {
        handle = await open(join(directory, '.cwd'), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stats = await handle.stat();
        if (stats.isFile() && stats.size <= MAX_GROK_CWD_BYTES) {
            const buffer = Buffer.alloc(stats.size);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const cwd = buffer.subarray(0, bytesRead).toString('utf8').trim();
            if (cwd) return cwd;
        }
    } catch {
        // No marker: the directory name is the encoded cwd.
    } finally {
        await handle?.close();
    }
    try {
        const cwd = decodeURIComponent(name);
        return cwd.startsWith('/') ? cwd : undefined;
    } catch {
        return undefined;
    }
}

async function grokSessionsIn(
    anchorRoot: string,
    directory: string,
): Promise<DiscoveredTranscript[]> {
    const baseRoot = join(anchorRoot, directory);
    const names = await subdirectories(baseRoot);
    const sessions = names.filter((name) => isOpaqueAgentSessionId(name));
    if (sessions.length === 0) return [];
    const cwd = await grokDirectoryCwd(baseRoot, directory);
    return sessions.map((session) => {
        const root = join(baseRoot, session);
        return {
            provider: 'grok',
            transcriptId: session,
            agentSessionId: session,
            main: { anchorRoot, baseRoot, root, path: join(root, 'updates.jsonl') },
            cwd,
            isContinuation: false,
        };
    });
}

/**
 * `$GROK_HOME/sessions/<encoded cwd>/<session id>/updates.jsonl`.
 */
async function discoverGrok(environment: AgentEnvironment): Promise<DiscoveredTranscript[]> {
    const anchorRoot = join(grokHome(environment), 'sessions');
    const found: DiscoveredTranscript[] = [];
    const directories = await subdirectories(anchorRoot);
    for (const directory of directories)
        // eslint-disable-next-line no-await-in-loop -- one directory at a time bounds open handles
        found.push(...(await grokSessionsIn(anchorRoot, directory)));
    return found;
}

/**
 * Exhaustive on purpose, like the usage parsers: a newly catalogued provider fails to compile until it declares where
 * its transcripts live.
 */
const discoverers: Record<
    AgentProvider,
    (environment: AgentEnvironment) => Promise<DiscoveredTranscript[]>
> = {
    claude: discoverClaude,
    codex: discoverCodex,
    grok: discoverGrok,
};

/**
 * Lists every Agent transcript on this machine from the providers' own directory layouts. Only names and directory
 * structure are read here; a transcript's contents are read later, through the safe transcript reader.
 */
export async function discoverTranscripts(
    environment: AgentEnvironment,
): Promise<DiscoveredTranscript[]> {
    const providers = Object.values(discoverers);
    const lists = await Promise.all(providers.map((discover) => discover(environment)));
    return lists.flat().slice(0, MAX_TRANSCRIPTS);
}

/**
 * Reads the working directory a Claude or Codex transcript records near its start. Only the matched path is kept.
 */
export async function readTranscriptCwd(
    location: AgentTranscriptLocation,
): Promise<string | undefined> {
    const opened = await openSafeAgentTranscript(location);
    if (!opened) return;
    try {
        const length = Math.min(opened.stats.size, CWD_HEAD_BYTES);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await opened.handle.read(buffer, 0, length, 0);
        const match = CWD_PATTERN.exec(buffer.subarray(0, bytesRead).toString('utf8'));
        if (!match) return;
        const cwd = JSON.parse(`"${match[1]}"`) as unknown;
        return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : undefined;
    } catch {
        return undefined;
    } finally {
        await opened.handle.close();
    }
}
