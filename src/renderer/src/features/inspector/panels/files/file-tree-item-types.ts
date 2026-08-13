import type { FileEntry } from '@shared/types';

/** Shared copy for every Paste/Duplicate/Drag affordance disabled by an in-flight file operation. */
export const BUSY_DISABLED_REASON = 'Busy — a file operation is in progress here';

export type EditRequest =
    | {
          kind: 'create';
          directory: string;
          itemKind: 'file' | 'directory';
          returnFocus: FocusTarget;
      }
    | { kind: 'rename'; entry: FileEntry };

export type FocusTarget =
    { kind: 'caption'; itemKind: 'file' | 'directory' } | { kind: 'path'; path: string };
