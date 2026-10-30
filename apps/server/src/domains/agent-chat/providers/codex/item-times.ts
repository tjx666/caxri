import { clip, isRecord, stringField } from '../../chat-items';
import type { AgentChatSessionHost } from '../../chat-provider';
import type { JsonRpcConnection } from '../../json-rpc-connection';
import { itemTimeOperations } from './turns';

/**
 * Bound on the read that dates resumed items; it only enriches Caxri's own projection.
 */
const READ_REQUEST_TIMEOUT_MS = 10_000;

/**
 * `thread/items/list` pages read to date a resumed history, newest first. Resume keeps at most 100 turns, and items
 * past this bound stay undated.
 */
const MAX_ITEM_TIME_PAGES = 10;
const ITEM_TIME_PAGE_SIZE = 200;

/**
 * Dates resumed items Codex's history does not time (#1657): `thread/resume` returns turns without item times, but
 * `thread/items/list` reports when each item started. Reads newest first and stops once every undated item is found or
 * after {@link MAX_ITEM_TIME_PAGES}; an older Codex without the method leaves them undated.
 */
export async function loadCodexItemTimes(
    connection: JsonRpcConnection,
    threadId: string,
    host: Pick<AgentChatSessionHost, 'apply' | 'read'>,
): Promise<void> {
    const undated = new Set(
        host
            .read()
            .items.filter((item) => item.createdAt === undefined && item.type !== 'notice')
            .map((item) => item.id),
    );
    const entries: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_ITEM_TIME_PAGES && undated.size > 0; page += 1) {
        let result: unknown;
        try {
            // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
            result = await connection.request(
                'thread/items/list',
                {
                    threadId,
                    limit: ITEM_TIME_PAGE_SIZE,
                    sortDirection: 'desc',
                    ...(cursor && { cursor }),
                },
                READ_REQUEST_TIMEOUT_MS,
            );
        } catch {
            break;
        }
        if (!isRecord(result) || !Array.isArray(result.data)) break;
        for (const entry of result.data) {
            entries.push(entry);
            const id =
                isRecord(entry) && isRecord(entry.item) ? stringField(entry.item.id) : undefined;
            if (id) undated.delete(clip(id, 200));
        }
        cursor = stringField(result.nextCursor);
        if (!cursor) break;
    }
    const operations = itemTimeOperations(host.read(), entries);
    if (operations.length > 0) host.apply(operations);
}
