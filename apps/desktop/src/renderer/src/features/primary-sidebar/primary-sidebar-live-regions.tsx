interface PrimarySidebarLiveRegionsProperties {
    /**
     * The Pinned group's move announcement. It reorders through its own controller, so it needs its own region: one
     * shared region would have to pick a winner whenever both held text, and an `aria-live` node that keeps swapping
     * owners re-announces the losing message.
     */
    pinnedOrderAnnouncement: string;
    /**
     * A pin is a separate event from a reorder, so it gets its own region for the same reason.
     */
    pinnedSessionAnnouncement: string;
    projectOrderAnnouncement: string;
    sessionOrderAnnouncement: string;
}

/**
 * The tree's screen-reader announcements for reorders and pins. They sit beside the `role="tree"` element rather than
 * inside it: a static region is not a tree row, and inside a tree every focusable element has to be a real `treeitem`.
 * The class names are the contract the E2E specs read.
 */
export function PrimarySidebarLiveRegions({
    pinnedOrderAnnouncement,
    pinnedSessionAnnouncement,
    projectOrderAnnouncement,
    sessionOrderAnnouncement,
}: PrimarySidebarLiveRegionsProperties) {
    return (
        <>
            <div className="project-order-announcement sr-only" aria-live="polite">
                {projectOrderAnnouncement}
            </div>
            <div className="session-order-announcement sr-only" aria-live="polite">
                {sessionOrderAnnouncement}
            </div>
            <div className="pinned-order-announcement sr-only" aria-live="polite">
                {pinnedOrderAnnouncement}
            </div>
            <div className="pinned-session-announcement sr-only" aria-live="polite">
                {pinnedSessionAnnouncement}
            </div>
        </>
    );
}
