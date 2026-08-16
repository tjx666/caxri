import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { E2EErrorEvent, E2EErrorSource } from './e2e-error-policy';

interface StructuredErrorRecord {
    event?: unknown;
    fields?: Record<string, unknown>;
    level?: unknown;
    process?: unknown;
}

export interface E2ELogSnapshot {
    contents: string;
    path: string;
    source: Exclude<E2EErrorSource, 'renderer'>;
}

const fatalLogEvents = new Set([
    'process_explorer.render_process_gone',
    'window.render_process_gone',
]);

function fallbackCode(event: string): string {
    return event.replaceAll(/[^A-Z0-9]+/gi, '_').toUpperCase();
}

function errorFromLog(record: StructuredErrorRecord): E2EErrorEvent | undefined {
    if (record.process !== 'host' && record.process !== 'main' && record.process !== 'runtime')
        return undefined;
    if (typeof record.event !== 'string') return undefined;
    if (record.level !== 'error' && record.level !== 'fatal' && !fatalLogEvents.has(record.event))
        return undefined;
    return {
        source: record.process,
        event: record.event,
        code:
            typeof record.fields?.code === 'string'
                ? record.fields.code
                : fallbackCode(record.event),
    };
}

function parseSnapshotErrors(snapshot: E2ELogSnapshot): E2EErrorEvent[] {
    const errors: E2EErrorEvent[] = [];
    for (const line of snapshot.contents.split('\n')) {
        if (!line) continue;
        try {
            const error = errorFromLog(JSON.parse(line) as StructuredErrorRecord);
            if (error) errors.push(error);
        } catch {
            errors.push({
                source: snapshot.source,
                event: 'e2e.log_invalid',
                code: 'INVALID_JSONL',
            });
        }
    }
    return errors;
}

/**
 * Reads the bounded logger rotation set synchronously so Electron teardown cannot delete the isolated profile before
 * Playwright has captured both the older and active process logs.
 */
export function readE2ELogSnapshots(userDataDirectory: string): E2ELogSnapshot[] {
    const snapshots: E2ELogSnapshot[] = [];
    for (const source of ['host', 'main', 'runtime'] as const) {
        const activePath = join(userDataDirectory, 'logs', `${source}.jsonl`);
        for (const path of [`${activePath}.1`, activePath]) {
            try {
                // oxlint-disable-next-line node/no-sync -- deliberate synchronous read; see the function doc comment above.
                snapshots.push({ source, path, contents: readFileSync(path, 'utf8') });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
    }
    return snapshots;
}

export function parseE2ELogErrors(snapshots: readonly E2ELogSnapshot[]): E2EErrorEvent[] {
    return snapshots.flatMap(parseSnapshotErrors);
}
