import { useFileLinkContextMenu } from '../../../components/markdown/file-link-context-menu';
import { Tooltip } from '../../../components/ui/tooltip';
import { useAgentChatRevealFileAction } from '../hooks/use-agent-chat-open-file';

/**
 * The file a work row names, underlined like a link and opening in the editor. It sits above the row's stretched
 * toggle, so clicking the name opens the file while the rest of the row still expands it. Its underline, not a dimmer
 * text, sets it apart from the row's muted verb, and it brightens with the underline on hover; the full path is one
 * hover away. A right-click opens the same Open File / Reveal in Finder / Copy Path menu as a path cited in a message.
 */
export function AgentChatWorkFileLink({
    path,
    subject,
    onOpenFile,
}: {
    path: string;
    subject: string;
    onOpenFile: (target: string) => void;
}) {
    const onContextMenu = useFileLinkContextMenu(path, onOpenFile, useAgentChatRevealFileAction());
    return (
        <Tooltip content={path}>
            <button
                className="relative min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-inherit underline decoration-current/40 underline-offset-2 hover:text-foreground hover:decoration-current focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={() => onOpenFile(path)}
                onContextMenu={onContextMenu}
            >
                {subject}
            </button>
        </Tooltip>
    );
}
