import type { ReactElement, RefObject } from 'react';
import { useEffect, useId, useState } from 'react';

import type { ProjectRecord } from '@caxri/protocol';
import { FolderClosed, MessageCircle } from 'lucide-react';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { useTranslation } from '../../i18n';
import { isRestoringPickerFocus } from '../../lib/picker-final-focus';
import { ProjectIcon } from './project-icon';
import { sidebarDetailCardDismissal } from './sidebar-detail-card-dismissal';

export function ProjectDetailsCard({
    anchor,
    project,
    sessionCount,
    suppressed = false,
    trigger,
}: {
    /**
     * Position beside the entire heading so the card cannot cover its sibling actions.
     */
    anchor: RefObject<HTMLElement | null>;
    project: ProjectRecord;
    sessionCount: number;
    /**
     * Keeps the card closed while the Project context menu owns the pointer.
     */
    suppressed?: boolean;
    trigger: ReactElement;
}) {
    const accessibleDescriptionId = useId();
    const [open, setOpen] = useState(false);
    const { t } = useTranslation();
    const visible = open && !suppressed;

    useEffect(() => {
        if (!visible) return;
        return sidebarDetailCardDismissal(() => setOpen(false));
    }, [visible]);

    return (
        <HoverCard open={visible} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
            <HoverCardTrigger
                aria-describedby={accessibleDescriptionId}
                closeDelay={80}
                delay={450}
                onFocus={(event) => {
                    if (isRestoringPickerFocus(event.currentTarget)) {
                        event.preventBaseUIHandler();
                        setOpen(false);
                        return;
                    }
                    if (event.currentTarget.matches(':focus-visible')) setOpen(true);
                }}
                render={trigger}
            />
            <span id={accessibleDescriptionId} className="sr-only">
                {t('primarySidebar.projectDetails.rootAriaDescription', { path: project.rootPath })}
            </span>
            <HoverCardContent
                anchor={anchor}
                align="start"
                className="project-details-card w-72 max-w-[calc(100vw-16px)] p-3"
                collisionAvoidance={{ align: 'shift', fallbackAxisSide: 'end', side: 'flip' }}
                collisionBoundary={document.documentElement}
                collisionPadding={8}
                positionMethod="fixed"
                role="tooltip"
                side="right"
                sideOffset={8}
            >
                <div className="flex min-w-0 items-start gap-2">
                    <ProjectIcon className="mt-0.5 flex-none" icon={project.icon} size={17} />
                    <div className="min-w-0 flex-1">
                        <h3 className="m-0 text-[13px] font-semibold wrap-break-word">
                            {project.title}
                        </h3>
                        <p className="mt-1 mb-0 flex items-center gap-1.5 text-[11px] text-muted">
                            <MessageCircle aria-hidden="true" className="flex-none" size={13} />
                            <span className="tabular-nums">
                                {t(
                                    sessionCount === 1
                                        ? 'primarySidebar.projectDetails.activeSessionsOne'
                                        : 'primarySidebar.projectDetails.activeSessionsOther',
                                    { count: sessionCount },
                                )}
                            </span>
                        </p>
                    </div>
                </div>
                <div className="mt-3 flex min-w-0 items-start gap-1.5 border-t border-border pt-2 text-[12px] leading-[1.45] text-muted">
                    <FolderClosed aria-hidden="true" className="mt-px flex-none" size={13} />
                    <span className="min-w-0 break-all">{project.rootPath}</span>
                </div>
            </HoverCardContent>
        </HoverCard>
    );
}
