import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentProviderDescriptor, AgentTitleSource } from '../../contract';
import { agentCommandEnvironment, assertAgentRenameVersion } from '../../rename';
import type { AgentTitleMessage } from '../../title-generation';
import {
    AGENT_TITLE_SYSTEM_INSTRUCTIONS,
    readAgentTitleSource,
    runAgentTitleCommand,
} from '../../title-generation';
import {
    claudeTranscriptBaseRoot,
    claudeTranscriptPath,
    claudeTranscriptRoot,
    resolveClaudeConfigDirectory,
} from './paths';

const CLAUDE_NAMING_MINIMUM_VERSION = '2.1.232';
const MAX_CLAUDE_METADATA_BYTES = 128 * 1024;
const MAX_CLAUDE_METADATA_FILES = 512;

interface ClaudeMetadata {
    name?: unknown;
    nameSource?: unknown;
    sessionId?: unknown;
}

async function readClaudeTitleOwnership(
    configDirectory: string,
    sessionId: string,
): Promise<Pick<AgentTitleSource, 'currentProviderTitle' | 'providerTitleState'>> {
    let names: string[];
    try {
        names = (await readdir(join(configDirectory, 'sessions')))
            .filter((name) => name.endsWith('.json'))
            .slice(0, MAX_CLAUDE_METADATA_FILES);
    } catch {
        return { providerTitleState: 'unknown' };
    }
    for (const name of names) {
        let handle: FileHandle | undefined;
        try {
            // eslint-disable-next-line no-await-in-loop -- bounded files are searched until the exact opaque id matches
            handle = await open(join(configDirectory, 'sessions', name), 'r');
            // eslint-disable-next-line no-await-in-loop -- the matching file must be parsed before continuing
            const stats = await handle.stat();
            if (stats.size > MAX_CLAUDE_METADATA_BYTES) continue;
            const buffer = Buffer.allocUnsafe(stats.size);
            // eslint-disable-next-line no-await-in-loop -- one bounded metadata file is read atomically by offset
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const metadata = JSON.parse(
                buffer.subarray(0, bytesRead).toString('utf8'),
            ) as ClaudeMetadata;
            if (metadata.sessionId !== sessionId) continue;
            const title = typeof metadata.name === 'string' ? metadata.name.trim() : '';
            return title && metadata.nameSource !== 'derived'
                ? { currentProviderTitle: title, providerTitleState: 'explicit' }
                : { providerTitleState: 'absent' };
        } catch {
            // Provider metadata is best-effort and schema drift simply removes the ownership hint.
        } finally {
            // eslint-disable-next-line no-await-in-loop -- each descriptor is closed before advancing
            await handle?.close();
        }
    }
    return { providerTitleState: 'unknown' };
}

function extractClaudeMessage(record: unknown): AgentTitleMessage | undefined {
    if (typeof record !== 'object' || record === null) return;
    const entry = record as { message?: { content?: unknown }; type?: unknown };
    if (entry.type !== 'user' && entry.type !== 'assistant') return;
    const content = entry.message?.content;
    const text = Array.isArray(content)
        ? content
              .flatMap((part) => {
                  if (typeof part === 'string') return [part];
                  if (
                      typeof part === 'object' &&
                      part !== null &&
                      (part as { type?: unknown }).type === 'text' &&
                      typeof (part as { text?: unknown }).text === 'string'
                  ) {
                      return [(part as { text: string }).text];
                  }
                  return [];
              })
              .join('\n')
        : typeof content === 'string'
          ? content
          : '';
    return text ? { role: entry.type, text } : undefined;
}

export const claudeNaming: NonNullable<AgentProviderDescriptor['naming']> = {
    async readOwnership(context, environment) {
        if (!context.agentSessionId) return { providerTitleState: 'unknown' };
        return readClaudeTitleOwnership(
            resolveClaudeConfigDirectory(environment),
            context.agentSessionId,
        );
    },
    async readSource(context, environment) {
        if (!context.agentSessionId) return;
        const configDirectory = resolveClaudeConfigDirectory(environment);
        const source = await readAgentTitleSource(
            {
                baseRoot: claudeTranscriptBaseRoot(configDirectory),
                path: claudeTranscriptPath(
                    configDirectory,
                    context.rootPath,
                    context.agentSessionId,
                ),
                root: claudeTranscriptRoot(configDirectory, context.rootPath),
            },
            extractClaudeMessage,
        );
        if (!source) return;
        const ownership = await readClaudeTitleOwnership(configDirectory, context.agentSessionId);
        return {
            ...source,
            ...ownership,
        };
    },
    async generateTitle(context) {
        assertAgentRenameVersion('claude', context.version, CLAUDE_NAMING_MINIMUM_VERSION);
        return runAgentTitleCommand({
            arguments: [
                '--print',
                '--model',
                'haiku',
                '--no-session-persistence',
                '--tools',
                '',
                '--mcp-config',
                '{"mcpServers":{}}',
                '--strict-mcp-config',
                '--setting-sources',
                '',
                '--no-chrome',
                '--disable-slash-commands',
                '--system-prompt',
                AGENT_TITLE_SYSTEM_INSTRUCTIONS,
                '--effort',
                'low',
                '--max-turns',
                '1',
            ],
            cwd: context.cwd,
            environment: agentCommandEnvironment(context.environment),
            executable: context.executable,
            input: context.prompt,
            signal: context.signal,
        });
    },
};
