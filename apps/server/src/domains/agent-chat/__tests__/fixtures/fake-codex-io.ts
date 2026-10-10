/**
 * The seam between the fake Codex app-server (`fake-codex-app-server.ts`) and its scenario modules.
 */

type Json = Record<string, unknown>;

export interface FakeItem {
    id: string;
    type: string;
    [key: string]: unknown;
}

export interface FakeTurn {
    id: string;
    /**
     * The child thread this turn belongs to; absent for the Chat's own thread.
     */
    threadId?: string;
    isCompaction?: boolean;
    items: FakeItem[];
    status: string;
    error: { message: string } | null;
    startedAt: number;
    durationMs?: number;
    interrupted?: boolean;
    finished?: boolean;
    onFinished?: () => void;
}

export interface FakeThread {
    id: string;
    turns: FakeTurn[];
    parentThreadId?: string;
    /**
     * The model and effort the last `turn/start` named, which a resumed thread reports.
     */
    model?: string;
    effort?: string;
}

/**
 * What the scenario modules beside `fake-codex-app-server.ts` need from the app-server process that hosts them.
 */
export interface FakeCodexIo {
    send(message: Json): void;
    /**
     * Sends a notification of the thread `turn` belongs to.
     */
    notifyTurn(turn: FakeTurn, method: string, parameters: Json): void;
    startItem(turn: FakeTurn, item: FakeItem): void;
    completeItem(turn: FakeTurn, item: FakeItem): void;
    streamMessage(turn: FakeTurn, text: string, chunkDelayMs: number): Promise<void>;
    save(thread?: FakeThread): void;
    currentThread(): FakeThread;
    /**
     * The Chat's own thread when it is open, or a persisted thread by id.
     */
    loadThread(id: string): FakeThread | undefined;
    /**
     * The turn fields Codex sends; the fake's own bookkeeping flags stay private.
     */
    wireTurn(turn: FakeTurn): Json;
    /**
     * Starts a turn of the Chat's own thread that Caxri did not ask for with `turn/start`.
     */
    beginTurn(): FakeTurn;
    finishTurn(turn: FakeTurn): void;
    /**
     * Sends an app-server request to the client and resolves with its response.
     */
    serverRequest(method: string, parameters: Json): Promise<unknown>;
}
