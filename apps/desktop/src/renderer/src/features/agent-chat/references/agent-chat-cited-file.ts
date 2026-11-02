import type { AgentChatItem } from '@caxri/protocol';
import { describeAgentChatWork, isAgentChatWorkItem } from '@caxri/protocol';

/**
 * The absolute file paths this Chat's own work touched: every file a change edited or created, and the path a read,
 * write, or edit tool named. Relative paths are dropped; they say nothing the cited text does not already say.
 */
export function agentChatTouchedFilePaths(
    itemSources: ReadonlyArray<readonly AgentChatItem[]>,
): Set<string> {
    const paths = new Set<string>();
    const add = (path: string | undefined): void => {
        if (path?.startsWith('/')) paths.add(path);
    };
    for (const item of itemSources.flat()) {
        if (!isAgentChatWorkItem(item) || item.type === 'reasoning') continue;
        if (item.type === 'fileChange') for (const change of item.changes) add(change.path);
        else add(describeAgentChatWork(item).path);
    }
    return paths;
}

/**
 * What a bare or relative citation names among the touched files: the one file (`path`), or every file sharing the name
 * (`candidates`, in the order the work touched them), which the user picks from.
 */
export type AgentChatCitedFile = { path: string } | { candidates: readonly string[] };

/**
 * The touched file a bare or relative citation (`plan.md`, `docs/plan.md`) names, matched on whole trailing path
 * segments. An Agent often cites a file it wrote outside every Project by its name alone, which the Project-scoped
 * resolver cannot find; the path its own tool call used can. Two or more matches come back as `candidates` instead of a
 * guess, so the caller can ask rather than claim the file is missing. An absolute, home, `./`, or `file://` citation,
 * or a name no touched file ends with, has no fallback.
 */
export function agentChatCitedFileFallback(
    target: string,
    touchedPaths: ReadonlySet<string>,
): AgentChatCitedFile | undefined {
    if (/^(?:\/|~|\.{1,2}\/|file:)/iu.test(target)) return undefined;
    const suffix = `/${target}`;
    const matches = [...touchedPaths].filter((path) => path.endsWith(suffix));
    const only = matches.at(0);
    if (only === undefined) return undefined;
    return matches.length === 1 ? { path: only } : { candidates: matches };
}
