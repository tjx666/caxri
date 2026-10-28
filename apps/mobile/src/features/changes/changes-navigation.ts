import { createSessionViewStore } from '../../lib/session-view-store';
import type { ChangedFile } from './changes-model';

/**
 * The file whose diff is open in a Session's Changes tab. It lives outside the view so the tab switch and the Android
 * Back that unmount Changes do not close the diff the reader was in the middle of.
 */
export const openDiffStore = createSessionViewStore<ChangedFile | null>(null);
