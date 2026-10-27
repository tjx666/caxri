import { createStore } from '../../lib/store';
import { useDialogStore } from '../../stores/dialogs';

interface BotDialogsState {
    /**
     * Whether the window's own Command Palette is open.
     */
    isPaletteOpen: boolean;
    /**
     * The open Clear Caxri Bot Data dialog, carried as a bumped revision so each open re-reads what there is to clear
     * and starts from the default selection instead of the previous one.
     */
    clearDataRequestId?: number;
    /**
     * The last revision handed out. It keeps counting while the dialog is closed, so no two opens share an ID.
     */
    lastClearDataRequestId: number;
}

/**
 * The Caxri Bot window's own dialogs. The window does not mount the Workbench's dialog store owners, so its palette and
 * Clear Caxri Bot Data dialog keep their open state here.
 */
export const useBotDialogsStore = createStore<BotDialogsState>('bot-dialogs', () => ({
    isPaletteOpen: false,
    lastClearDataRequestId: 0,
}));

export function setBotPaletteOpen(isPaletteOpen: boolean): void {
    useBotDialogsStore.setState({ isPaletteOpen });
}

/**
 * Opens the palette unless a dialog is already open, as the Workbench's `runCommand` gate does. A palette over Clear
 * Caxri Bot Data could reopen that dialog and drop the user's selection, or stack a second dialog on the first.
 */
export function requestBotPalette(): void {
    if (!useDialogStore.getState().isModalOpen()) setBotPaletteOpen(true);
}

export function openBotClearData(): void {
    useBotDialogsStore.setState((state) => ({
        isPaletteOpen: false,
        clearDataRequestId: state.lastClearDataRequestId + 1,
        lastClearDataRequestId: state.lastClearDataRequestId + 1,
    }));
}

/**
 * Closes the Clear Caxri Bot Data dialog. A clear that finishes after the user closed the dialog and opened it again
 * passes its own request ID, so it does not close the newer one.
 */
export function closeBotClearData(requestId?: number): void {
    useBotDialogsStore.setState((state) =>
        requestId === undefined || state.clearDataRequestId === requestId
            ? { clearDataRequestId: undefined }
            : state,
    );
}
