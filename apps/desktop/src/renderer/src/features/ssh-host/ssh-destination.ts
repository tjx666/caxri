import type { SshHostEntry } from '@caxri/protocol';
import { sshDestinationSchema } from '@caxri/protocol';

/**
 * One choosable destination in the Connect to SSH Host picker.
 */
export interface SshHostPickerRow {
    destination: string;
    /**
     * `user@hostName:port` resolved from `~/.ssh/config`, when it adds something the destination does not already say.
     */
    detail?: string;
}

export interface SshHostPickerRows {
    /**
     * The typed text as a destination of its own, offered first so Enter connects to exactly what was typed. Absent
     * while the query is empty, invalid, or already names a listed row.
     */
    typed?: SshHostPickerRow;
    /**
     * Set when the typed text can never be a destination, so the picker explains why Enter does nothing.
     */
    isInvalid: boolean;
    recent: SshHostPickerRow[];
    hosts: SshHostPickerRow[];
}

/**
 * Validates typed text against the same schema Main applies, so a destination that would be refused (a leading `-` that
 * OpenSSH would parse as an option, embedded whitespace) is caught before any request.
 */
export function parseSshDestination(input: string): string | undefined {
    const parsed = sshDestinationSchema.safeParse(input.trim());
    return parsed.success ? parsed.data : undefined;
}

/**
 * Describes where a `~/.ssh/config` alias really goes, or `undefined` when the entry says nothing beyond its alias.
 */
export function sshHostDetail(entry: SshHostEntry): string | undefined {
    if (entry.hostName === undefined && entry.user === undefined && entry.port === undefined)
        return undefined;
    const user = entry.user === undefined ? '' : `${entry.user}@`;
    const port = entry.port === undefined ? '' : `:${entry.port}`;
    const detail = `${user}${entry.hostName ?? entry.alias}${port}`;
    return detail === entry.alias ? undefined : detail;
}

function isMatch(row: SshHostPickerRow, query: string): boolean {
    if (!query) return true;
    const needle = query.toLowerCase();
    return (
        row.destination.toLowerCase().includes(needle) ||
        (row.detail?.toLowerCase().includes(needle) ?? false)
    );
}

/**
 * Builds the picker list: the typed destination, then recent destinations (most recent first, as Main stores them),
 * then `~/.ssh/config` hosts that were not already listed as recent. A recent alias keeps its config detail so the two
 * groups describe the same host the same way.
 */
export function buildSshHostPickerRows({
    hosts,
    query,
    recent,
}: {
    hosts: readonly SshHostEntry[];
    query: string;
    recent: readonly string[];
}): SshHostPickerRows {
    const trimmed = query.trim();
    const details = new Map(hosts.map((entry) => [entry.alias, sshHostDetail(entry)]));
    const seen = new Set<string>();
    const recentRows: SshHostPickerRow[] = [];
    for (const destination of recent) {
        if (seen.has(destination)) continue;
        seen.add(destination);
        const detail = details.get(destination);
        recentRows.push({ destination, ...(detail && { detail }) });
    }
    const hostRows: SshHostPickerRow[] = [];
    for (const entry of hosts) {
        if (seen.has(entry.alias)) continue;
        seen.add(entry.alias);
        const detail = sshHostDetail(entry);
        hostRows.push({ destination: entry.alias, ...(detail && { detail }) });
    }
    const destination = trimmed ? parseSshDestination(trimmed) : undefined;
    return {
        ...(destination && !seen.has(destination) && { typed: { destination } }),
        isInvalid: trimmed !== '' && destination === undefined,
        recent: recentRows.filter((row) => isMatch(row, trimmed)),
        hosts: hostRows.filter((row) => isMatch(row, trimmed)),
    };
}
