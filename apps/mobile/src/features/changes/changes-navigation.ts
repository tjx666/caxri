import { createSessionViewStore } from '../../lib/session-view-store';
import type { ChangedFile, ChangesMode } from './changes-model';

/**
 * The file whose diff is open in a Session's Changes tab. It lives outside the view so the tab switch and the Android
 * Back that unmount Changes do not close the diff the reader was in the middle of.
 */
export const openDiffStore = createSessionViewStore<ChangedFile | null>(null);

/**
 * The Changes tab's mode per Session, kept for the same reason as the open diff: a tab switch must not reset it.
 */
export const changesModeStore = createSessionViewStore<ChangesMode>('working');
