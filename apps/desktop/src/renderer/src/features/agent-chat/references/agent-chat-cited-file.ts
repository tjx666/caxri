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
 * The one touched file a bare or relative citation (`plan.md`, `docs/plan.md`) names, matched on whole trailing path
 * segments. An Agent often cites a file it wrote outside every Project by its name alone, which the Project-scoped
 * resolver cannot find; the path its own tool call used can. An absolute, home, `./`, or `file://` citation, or a name
 * several touched files share, has no fallback.
 */
export function agentChatCitedFileFallback(
    target: string,
    touchedPaths: ReadonlySet<string>,
): string | undefined {
    if (/^(?:\/|~|\.{1,2}\/|file:)/iu.test(target)) return undefined;
    const suffix = `/${target}`;
    let match: string | undefined;
    for (const path of touchedPaths) {
        if (!path.endsWith(suffix)) continue;
        if (match !== undefined) return undefined;
        match = path;
    }
    return match;
}
