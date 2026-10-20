import type { LocalAgentState } from '../../contract';
import { isOpaqueAgentSessionId } from '../../contract';
import type { TranscriptScanCursor } from '../../transcript-scan';
import { scanTranscriptLines } from '../../transcript-scan';
import type { ClaudeSessionMetadata } from './metadata-cache';
import { claudeTranscriptBaseRoot, claudeTranscriptPath, claudeTranscriptRoot } from './paths';

const MAX_TRANSCRIPT_TITLE_CACHES = 64;

interface TranscriptTitleCache extends TranscriptScanCursor {
    /**
     * Latest `ai-title` record: Claude Code's own generated title, re-appended after later turns.
     */
    aiTitle?: string;
    /**
     * Latest `custom-title` record: the `/rename` result, including Caxri's non-interactive manual rename.
     */
    customTitle?: string;
}

/**
 * Mirrors Claude Code's own resolution (`customTitle || aiTitle`). Claude Code keeps regenerating `ai-title` after
 * later turns, so a "last record wins" read let its generated title silently replace the `/rename` result and the
 * displayed title flapped between the two.
 */
function transcriptTitle(cache: TranscriptTitleCache): string | undefined {
    return cache.customTitle ?? cache.aiTitle;
}
/**
 * Incremental per-transcript scan state so the frequent agent-metadata polls only read appended bytes instead of
 * rescanning multi-megabyte transcripts on every refresh.
 */
const transcriptTitleCaches = new Map<string, TranscriptTitleCache>();

/**
 * Claude Code appends an `ai-title` record for its own generated title and a `custom-title` record for `/rename`,
 * including the non-interactive `/rename` Caxri issues for a manual Session rename. The live `sessions/<pid>.json`
 * metadata is owned by the interactive process and keeps its directory-derived `name` after an external rename, so the
 * transcript is the only place the renamed title can be read back from. The two record kinds are tracked separately
 * because a `custom-title` outranks any `ai-title` regardless of append order; see {@link transcriptTitle}.
 */
function scanTranscriptLine(line: string, cache: TranscriptTitleCache): void {
    if (!line.includes('"aiTitle"') && !line.includes('"customTitle"')) return;
    try {
        const record = JSON.parse(line) as {
            aiTitle?: unknown;
            customTitle?: unknown;
            type?: unknown;
        };
        if (record.type === 'ai-title') {
            if (typeof record.aiTitle !== 'string') return;
            const title = record.aiTitle.trim();
            if (title) cache.aiTitle = title;
        } else if (record.type === 'custom-title') {
            if (typeof record.customTitle !== 'string') return;
            const title = record.customTitle.trim();
            if (title) cache.customTitle = title;
        }
    } catch {
        /*
        Partial or malformed lines are skipped; a later append re-delivers them complete.
        */
    }
}

/**
 * Reads only Claude Code's generated title from the matched Session transcript. Raw prompts are intentionally excluded
 * because this title also reaches Caxri persistence and native operating-system notifications.
 */
async function readTranscriptTitles(
    configDirectory: string,
    cwd: string,
    sessionId: string,
): Promise<TranscriptTitleCache> {
    const path = claudeTranscriptPath(configDirectory, cwd, sessionId);
    let cache = transcriptTitleCaches.get(path);
    if (!cache) {
        cache = { offset: 0 };
        transcriptTitleCaches.set(path, cache);
        if (transcriptTitleCaches.size > MAX_TRANSCRIPT_TITLE_CACHES) {
            const oldest = transcriptTitleCaches.keys().next().value;
            if (oldest !== undefined) transcriptTitleCaches.delete(oldest);
        }
    }
    if (!isOpaqueAgentSessionId(sessionId)) return cache;
    const titleCache = cache;
    await scanTranscriptLines(
        {
            baseRoot: claudeTranscriptBaseRoot(configDirectory),
            path,
            root: claudeTranscriptRoot(configDirectory, cwd),
        },
        titleCache,
        (line) => scanTranscriptLine(line, titleCache),
        {
            onReset: () => {
                titleCache.aiTitle = undefined;
                titleCache.customTitle = undefined;
            },
        },
    );
    return cache;
}

/**
 * Resolves the display title without ever promoting a raw prompt into Caxri persistence or an OS notification.
 *
 * A `derived` metadata name (`<directory>-xx`) is a placeholder Claude Code assigns before any real title exists. It is
 * never returned as a title: `decideAgentMetadataUpdate` would otherwise persist it over the title the last rename just
 * wrote, because the interactive process never refreshes its metadata `name` after an external `/rename`. Returning
 * `undefined` keeps the Session's current title instead.
 */
export async function resolveClaudeTitle(
    metadata: ClaudeSessionMetadata,
    configDirectory: string,
): Promise<Pick<LocalAgentState, 'title' | 'titleSource'>> {
    const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
    if (typeof metadata.cwd === 'string' && typeof metadata.sessionId === 'string') {
        const transcript = await readTranscriptTitles(
            configDirectory,
            metadata.cwd,
            metadata.sessionId,
        );
        if (transcript.customTitle)
            return { title: transcript.customTitle, titleSource: 'explicit' };
        if (name && metadata.nameSource === 'user') return { title: name, titleSource: 'explicit' };
        const title = transcriptTitle(transcript);
        if (title) return { title, titleSource: 'automatic' };
    }
    return name && metadata.nameSource !== 'derived'
        ? {
              title: name,
              ...(metadata.nameSource === 'user'
                  ? { titleSource: 'explicit' as const }
                  : { titleSource: 'automatic' as const }),
          }
        : {};
}
