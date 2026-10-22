/**
 * The seam between the fake Codex app-server (`fake-codex-app-server.ts`) and its scenario modules.
 */

type Json = Record<string, unknown>;

/**
 * Loose wire shapes: the fake reads only the fields it answers.
 */
export interface RpcMessage {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
}

export interface FakeInput {
    type: string;
    text?: string;
    url?: string;
}

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
    /**
     * Steered messages held while the turn compacts its context, which Codex records only once the compaction ends.
     */
    deferredSteers?: Array<() => void>;
    items: FakeItem[];
    status: string;
    error: { message: string } | null;
    startedAt: number;
    /**
     * When each item started, in milliseconds, which `thread/items/list` reports.
     */
    itemTimes?: Record<string, number>;
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
     * The model, effort, and service tier the last `turn/start` named, which a resumed thread reports.
     */
    model?: string;
    effort?: string;
    serviceTier?: string;
    /**
     * The collaboration mode the last `turn/start` named (`plan` or `default`), which a resumed thread reports.
     */
    collaborationMode?: string;
    /**
     * The thread goal `thread/goal/set` saved, in Codex's wire shape.
     */
    goal?: Json;
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
    streamMessage(
        turn: FakeTurn,
        text: string | readonly string[],
        chunkDelayMs: number,
    ): Promise<void>;
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
    /**
     * Whether a turn of the Chat's own thread is running.
     */
    hasActiveTurn(): boolean;
    finishTurn(turn: FakeTurn): void;
    /**
     * Sends an app-server request to the client and resolves with its response.
     */
    serverRequest(method: string, parameters: Json): Promise<unknown>;
}
