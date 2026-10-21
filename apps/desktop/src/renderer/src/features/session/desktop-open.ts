import type { EditorNavigationTarget } from '@caxri/protocol';

export interface DesktopOpenRequest {
    /**
     * The opening caller's intent, forwarded unchanged from `desktop.openFile`: a file picker or a Terminal path link
     * wants the keyboard in the editor, a shell-issued `caxri open` does not.
     */
    focusEditor?: boolean;
    /**
     * `directory` means `path` names a directory to reveal in the Files explorer instead of a file to open. Absent for
     * a file.
     */
    kind?: 'directory';
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
    /**
     * Shows the Files explorer of `sessionId` with the directory selected and expanded. Runs after the Session is
     * selected, because the explorer draws the selected Session's tree.
     */
    revealDirectory(sessionId: string, path: string): void;
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
                if (request.kind === 'directory') {
                    actions.revealDirectory(request.sessionId, request.path);
                    return;
                }
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
