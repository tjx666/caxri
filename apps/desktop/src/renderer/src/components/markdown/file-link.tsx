import type { ReactNode } from 'react';

import { Tooltip } from '../ui/tooltip';
import { useFileLinkContextMenu } from './file-link-context-menu';
import { InlineButton } from './inline-button';

/**
 * A local file cited in Markdown, as path-like inline code or a link whose destination is a file. A click opens it; a
 * right-click opens its own menu (Open File, Reveal in Finder, Copy Path) instead of the enclosing message's.
 */
export function FileLink({
    children,
    className,
    file,
    onOpen,
    onReveal,
    tooltip,
}: {
    children: ReactNode;
    className: string;
    file: string;
    onOpen: (file: string) => void;
    onReveal: ((file: string) => void) | undefined;
    tooltip: string;
}) {
    const onContextMenu = useFileLinkContextMenu(file, onOpen, onReveal);
    return (
        <Tooltip content={tooltip}>
            <InlineButton
                className={className}
                onClick={() => onOpen(file)}
                onContextMenu={onContextMenu}
            >
                {children}
            </InlineButton>
        </Tooltip>
    );
}
