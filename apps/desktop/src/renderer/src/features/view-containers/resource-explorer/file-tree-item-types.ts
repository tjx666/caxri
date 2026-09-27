import type { FileEntry } from '@caxri/protocol';

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
