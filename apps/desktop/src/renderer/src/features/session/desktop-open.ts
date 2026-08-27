export interface DesktopOpenRequest {
    location?: { column: number; line: number };
    path?: string;
    sessionId: string;
}

export interface DesktopOpenQueueActions {
    openFile(
        sessionId: string,
        path: string,
        location?: { column: number; line: number },
    ): Promise<unknown>;
    selectSession(sessionId: string): Promise<boolean>;
}

/**
 * Server commands arrive over a one-shot event channel, so serialize them before they mutate the selected Session. This
 * preserves each target's identity without making the Server wait for editor rendering or turning Renderer work into a
 * second IPC protocol.
 */
export function createDesktopOpenQueue(actions: DesktopOpenQueueActions) {
    let tail = Promise.resolve();

    return {
        async enqueue(request: DesktopOpenRequest): Promise<void> {
            const operation = (async () => {
                await tail;
                if (!(await actions.selectSession(request.sessionId)) || !request.path) return;
                await actions.openFile(request.sessionId, request.path, request.location);
            })();
            /**
             * A rejected one-shot request must not prevent later Server targets from being handled.
             */
            tail = (async () => {
                try {
                    await operation;
                } catch {
                    // ignored: see the comment above.
                }
            })();
            return operation;
        },
    };
}
