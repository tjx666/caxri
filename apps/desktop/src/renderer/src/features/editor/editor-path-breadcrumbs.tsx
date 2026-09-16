import { useEffect, useRef } from 'react';

import { ChevronRight } from 'lucide-react';

import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { cn } from '../../lib/utilities';
import { readOnlyBreadcrumbSegments } from './editor-breadcrumbs-model';

/**
 * Display-only breadcrumb rail for a document whose ancestors the Renderer cannot list: a file authorized outside every
 * Project root (`~/.zshrc`), or a Git diff whose path exists only inside a revision. It shares the interactive rail's
 * metrics and scroll behavior so a Session cannot tell which editor it is looking at by the header alone, and it stays
 * out of the tab order because there is nothing to activate.
 *
 * @see EditorBreadcrumbs for the in-Project rail, whose segments open a sibling picker.
 */
export function EditorPathBreadcrumbs({
    accessibilityLabel,
    className,
    path,
}: {
    accessibilityLabel: string;
    className?: string;
    path: string;
}) {
    const segments = readOnlyBreadcrumbSegments(path);
    const lastSegmentReference = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        lastSegmentReference.current?.scrollIntoView({ block: 'nearest', inline: 'end' });
    }, [path]);

    if (segments.length === 0) return null;

    return (
        <nav
            aria-label={accessibilityLabel}
            className={cn(
                'editor-breadcrumbs flex min-w-0 flex-1 items-center overflow-x-auto px-2 text-[12px] text-muted',
                className,
            )}
        >
            {segments.map(({ label, trail }, index) => {
                const isFile = index === segments.length - 1;
                return (
                    <div key={trail} className="flex shrink-0 items-center">
                        {index > 0 && (
                            <ChevronRight
                                aria-hidden="true"
                                className="shrink-0 text-muted"
                                size={12}
                            />
                        )}
                        <span
                            ref={isFile ? lastSegmentReference : undefined}
                            aria-current={isFile ? 'page' : undefined}
                            className={cn(
                                'flex h-6 max-w-64 items-center gap-1 px-1',
                                isFile && 'text-foreground',
                            )}
                        >
                            {isFile && <FileTypeIcon entry={{ kind: 'file', name: label }} />}
                            <span className="truncate">{label}</span>
                        </span>
                    </div>
                );
            })}
        </nav>
    );
}
