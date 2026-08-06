import type { FileEntry } from '@shared/types';

import { resolveFileIcon } from './file-icon-resolver';

export function FileTypeIcon({
    entry,
    expanded = false,
}: {
    entry: Pick<FileEntry, 'kind' | 'name'>;
    expanded?: boolean;
}) {
    const icon = resolveFileIcon(entry, expanded);
    return (
        <img
            alt=""
            aria-hidden="true"
            className="file-type-icon w-4 h-4 flex-none object-contain"
            data-file-icon={icon.id}
            draggable={false}
            src={icon.src}
        />
    );
}
