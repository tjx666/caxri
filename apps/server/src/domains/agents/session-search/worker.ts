import { parentPort, workerData } from 'node:worker_threads';

import type { AgentProvider } from '@caxri/protocol';

import { SessionSearchEngine } from './engine';
import { SessionSearchStore } from './store';
import type {
    SessionSearchWorkerData,
    SessionSearchWorkerReply,
    SessionSearchWorkerRequest,
} from './worker-protocol';

/**
 * Session search Worker entry: owns the index database and every transcript read, so a first build over gigabytes of
 * history or a substring scan never blocks Server Core's event loop. Server Core starts it on demand and terminates it
 * once idle.
 */
async function main(): Promise<void> {
    const port = parentPort;
    if (!port) return;
    const post = (reply: SessionSearchWorkerReply) => port.postMessage(reply);
    const { databasePath, environment } = workerData as SessionSearchWorkerData;
    let store: SessionSearchStore;
    try {
        store = await SessionSearchStore.open(databasePath);
    } catch {
        post({ type: 'unavailable' });
        return;
    }
    const engine: SessionSearchEngine = new SessionSearchEngine(store, environment, {
        onPass: (report) => post({ type: 'pass', report, status: engine.status() }),
        onPassFailed: () => post({ type: 'passFailed', status: engine.status() }),
    });
    /**
     * Searches wait one turn of the event loop so a `cancel` that arrived behind them can drop them first.
     */
    const queued = new Set<number>();
    const inspect = async (id: number, provider: AgentProvider, agentSessionId: string) => {
        try {
            const conversation = await engine.indexer.inspect(provider, agentSessionId);
            post({ type: 'inspect', id, conversation });
        } catch {
            post({ type: 'error', id, reason: 'failed' });
        }
    };
    port.on('message', (message: SessionSearchWorkerRequest) => {
        if (message.type === 'cancel') {
            queued.delete(message.id);
            return;
        }
        if (message.type === 'search') {
            queued.add(message.id);
            setImmediate(() => {
                if (!queued.delete(message.id)) return;
                try {
                    post({
                        type: 'search',
                        id: message.id,
                        response: engine.search(message.request),
                    });
                } catch {
                    post({ type: 'error', id: message.id, reason: 'failed' });
                }
            });
            return;
        }
        if (message.type === 'describe') {
            // A Session's hover card may be the first reader after launch; the titles it misses now arrive with the
            // background pass, in time for the next hover.
            engine.refreshIfStale();
            try {
                post({
                    type: 'describe',
                    id: message.id,
                    titles: message.conversations.map(
                        ({ provider, agentSessionId }) =>
                            store
                                .conversationTranscripts(provider, agentSessionId)
                                .find((transcript) => !transcript.isContinuation)?.title,
                    ),
                });
            } catch {
                post({ type: 'error', id: message.id, reason: 'failed' });
            }
            return;
        }
        void inspect(message.id, message.provider, message.agentSessionId);
    });
    port.on('close', () => store.close());
}

void main();
