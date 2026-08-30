import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

import Database from 'better-sqlite3';

import type { AgentProviderDescriptor } from '../../contract';
import { canonicalPath } from '../../contract';
import { agentCommandEnvironment, assertAgentRenameVersion } from '../../rename';
import type { AgentTitleMessage } from '../../title-generation';
import {
    AGENT_TITLE_SYSTEM_INSTRUCTIONS,
    readAgentTitleSource,
    runAgentTitleCommand,
} from '../../title-generation';
import type { AgentTranscriptLocation } from '../../transcript-security';
import { resolveCodexHome, resolveCodexStateDirectories } from './paths';
import { findCodexStateDatabases } from './state-databases';

const CODEX_NAMING_MINIMUM_VERSION = '0.122.0';
const CODEX_TITLE_MODEL = 'gpt-5.6-luna';
const MACOS_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';

interface SqliteColumn {
    name: string;
}

interface NamingThreadRow {
    gitBranch?: string;
    name?: string;
    rolloutPath?: string;
    title?: string;
}

async function readNamingThread(
    directories: readonly string[],
    threadId: string,
): Promise<NamingThreadRow | undefined> {
    const databasePaths = await findCodexStateDatabases(directories);
    for (const path of databasePaths) {
        let database: Database.Database | undefined;
        try {
            database = new Database(path, { fileMustExist: true, readonly: true });
            const columns = new Set(
                (database.prepare('PRAGMA table_info(threads)').all() as SqliteColumn[]).map(
                    (column) => column.name,
                ),
            );
            if (!columns.has('id') || !columns.has('title') || !columns.has('rollout_path'))
                continue;
            const row = database
                .prepare(
                    `SELECT title, ${columns.has('name') ? 'name' : 'NULL'} AS name, ${
                        columns.has('git_branch') ? 'git_branch' : 'NULL'
                    } AS gitBranch, rollout_path AS rolloutPath FROM threads WHERE id = ? LIMIT 1`,
                )
                .get(threadId) as NamingThreadRow | undefined;
            if (row) return row;
        } catch {
            // Provider-private schema drift degrades automatic naming to unavailable.
        } finally {
            database?.close();
        }
    }
    return undefined;
}

function rolloutLocation(
    codexHome: string,
    path: string,
    threadId: string,
): AgentTranscriptLocation | undefined {
    const sessionsRoot = resolve(codexHome, 'sessions');
    const resolvedPath = resolve(path);
    const parts = relative(sessionsRoot, resolvedPath).split(sep);
    if (
        parts.length !== 4 ||
        !/^\d{4}$/.test(parts[0] ?? '') ||
        !/^\d{2}$/.test(parts[1] ?? '') ||
        !/^\d{2}$/.test(parts[2] ?? '') ||
        !basename(resolvedPath).endsWith(`-${threadId}.jsonl`)
    ) {
        return;
    }
    const baseRoot = join(sessionsRoot, parts[0], parts[1]);
    return {
        anchorRoot: sessionsRoot,
        baseRoot,
        path: resolvedPath,
        root: join(baseRoot, parts[2]),
    };
}

function isInjectedUserContext(text: string): boolean {
    const value = text.trimStart();
    return [
        '# AGENTS.md instructions for ',
        '<environment_context>',
        '<permissions instructions>',
        '<collaboration_mode>',
        '<plugins_instructions>',
    ].some((prefix) => value.startsWith(prefix));
}

function extractCodexMessage(record: unknown): AgentTitleMessage | undefined {
    if (typeof record !== 'object' || record === null) return;
    const entry = record as {
        payload?: { content?: unknown; role?: unknown; type?: unknown };
        type?: unknown;
    };
    if (entry.type !== 'response_item' || entry.payload?.type !== 'message') return;
    if (entry.payload.role !== 'user' && entry.payload.role !== 'assistant') return;
    const role = entry.payload.role;
    const content = Array.isArray(entry.payload.content) ? entry.payload.content : [];
    const messageParts: string[] = [];
    for (const part of content) {
        if (typeof part !== 'object' || part === null) continue;
        const candidate = part as { text?: unknown; type?: unknown };
        if (
            !['input_text', 'output_text', 'text'].includes(String(candidate.type)) ||
            typeof candidate.text !== 'string' ||
            (role === 'user' && isInjectedUserContext(candidate.text))
        )
            continue;
        messageParts.push(candidate.text);
    }
    const text = messageParts.join('\n').trim();
    return text ? { role, text } : undefined;
}

function parseCodexTitle(stdout: string): string {
    let title = '';
    for (const line of stdout.split('\n')) {
        try {
            const event = JSON.parse(line) as {
                item?: { text?: unknown; type?: unknown };
                type?: unknown;
            };
            if (
                event.type === 'item.completed' &&
                event.item?.type === 'agent_message' &&
                typeof event.item.text === 'string'
            ) {
                title = event.item.text.trim();
            }
        } catch {
            // Non-JSON diagnostics and unrelated stream events are ignored.
        }
    }
    return title;
}

function trimmed(value: string | undefined): string | undefined {
    const result = value?.trim();
    if (result) return result;
    return undefined;
}

/**
 * Codex has no CLI switch for its global AGENTS.md. The macOS host sandbox therefore denies both global instruction
 * files and the Project itself while leaving provider authentication and model network access intact.
 */
function codexNamingSandboxProfile(projectDirectory: string, codexHome: string): string {
    return [
        '(version 1)',
        '(allow default)',
        `(deny file-read* (subpath ${JSON.stringify(projectDirectory)}))`,
        `(deny file-read* (literal ${JSON.stringify(join(codexHome, 'AGENTS.md'))}))`,
        `(deny file-read* (literal ${JSON.stringify(join(codexHome, 'AGENTS.override.md'))}))`,
    ].join(' ');
}

export const codexNaming: NonNullable<AgentProviderDescriptor['naming']> = {
    async readOwnership(context, environment) {
        if (!context.agentSessionId) return { providerTitleState: 'unknown' };
        const thread = await readNamingThread(
            resolveCodexStateDirectories(environment),
            context.agentSessionId,
        );
        if (!thread) return { providerTitleState: 'unknown' };
        const currentProviderTitle = trimmed(thread.name);
        return currentProviderTitle
            ? { currentProviderTitle, providerTitleState: 'explicit' }
            : { providerTitleState: 'absent' };
    },
    async readSource(context, environment) {
        if (!context.agentSessionId) return;
        const thread = await readNamingThread(
            resolveCodexStateDirectories(environment),
            context.agentSessionId,
        );
        if (!thread?.rolloutPath) return;
        const location = rolloutLocation(
            resolveCodexHome(environment),
            thread.rolloutPath,
            context.agentSessionId,
        );
        if (!location) return;
        const source = await readAgentTitleSource(location, extractCodexMessage);
        if (!source) return;
        const currentProviderTitle = trimmed(thread.name);
        return {
            ...source,
            currentProviderTitle,
            gitBranch: trimmed(thread.gitBranch),
            providerTitleState: currentProviderTitle ? 'explicit' : 'absent',
        };
    },
    async generateTitle(context) {
        assertAgentRenameVersion('codex', context.version, CODEX_NAMING_MINIMUM_VERSION);
        const isolatedDirectory = await mkdtemp(join(tmpdir(), 'caxri-codex-title-'));
        try {
            const [canonicalProjectDirectory, canonicalCodexHome] = await Promise.all([
                canonicalPath(context.cwd),
                canonicalPath(resolveCodexHome(context.environment)),
            ]);
            const codexArguments = [
                'exec',
                '--ephemeral',
                '--ignore-user-config',
                '--ignore-rules',
                '--disable',
                'codex_hooks',
                '--disable',
                'shell_tool',
                '--disable',
                'multi_agent',
                '--disable',
                'apps',
                '--skip-git-repo-check',
                '-m',
                CODEX_TITLE_MODEL,
                '-c',
                'model_reasoning_effort="low"',
                '-c',
                'project_doc_max_bytes=0',
                '-c',
                'project_doc_fallback_filenames=[]',
                '-c',
                'web_search="disabled"',
                '-s',
                'read-only',
                '--json',
                '-',
            ];
            const output = await runAgentTitleCommand({
                arguments: [
                    '-p',
                    codexNamingSandboxProfile(canonicalProjectDirectory, canonicalCodexHome),
                    context.executable,
                    ...codexArguments,
                ],
                cwd: isolatedDirectory,
                environment: agentCommandEnvironment(context.environment),
                executable: MACOS_SANDBOX_EXECUTABLE,
                input: `${AGENT_TITLE_SYSTEM_INSTRUCTIONS}\n\n${context.prompt}`,
                signal: context.signal,
            });
            return parseCodexTitle(output);
        } finally {
            await rm(isolatedDirectory, { recursive: true, force: true });
        }
    },
};
