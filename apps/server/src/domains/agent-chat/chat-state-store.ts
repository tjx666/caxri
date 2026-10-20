import type { CaxriDatabase } from '../db';
import { AgentChatStateModel } from '../db';

const stores = new WeakMap<object, AgentChatStateModel>();

/**
 * The durable Agent Chat state (answered notices, provider process groups, a rewind's resume point) over the Server's
 * open SQLite handle; one store per database, shared by every Chat module that needs it.
 */
export function chatStateStore(database: CaxriDatabase): AgentChatStateModel {
    const handle = database.database;
    let store = stores.get(handle);
    if (!store) {
        store = new AgentChatStateModel(handle);
        stores.set(handle, store);
    }
    return store;
}
