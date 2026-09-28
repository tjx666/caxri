import type { EditorNavigationTarget } from '@caxri/protocol';

export interface DesktopOpenRequest {
    /**
     * The opening caller's intent, forwarded unchanged from `desktop.openFile`: a file picker or a Terminal path link
     * wants the keyboard in the editor, a shell-issued `caxri open` does not.
     */
    focusEditor?: boolean;
    location?: EditorNavigationTarget;
    path?: string;
    sessionId: string;
}

export interface DesktopOpenQueueActions {
    openFile(
        sessionId: string,
        path: string,
        options?: { focusEditor?: boolean; location?: EditorNavigationTarget },
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
                const selected = await actions.selectSession(request.sessionId);
                if (!selected || !request.path) return;
                await actions.openFile(request.sessionId, request.path, {
                    ...(request.location && { location: request.location }),
                    ...(request.focusEditor && { focusEditor: true }),
                });
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
