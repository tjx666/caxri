import type { DragEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ProjectRecord } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { environmentOfProject } from '../../../lib/environment-routing';
import { PROJECT_PATH_DRAG_TYPE } from '../../../lib/file-drag';
import { didReorderProject } from '../../session/session-commands';
import type { MergedProject } from '../project-merge';
import type { ProjectDropTarget } from '../project-order';
import {
    adjacentProjectOrder,
    areProjectDropTargetsEqual,
    createLatestProjectOrderQueue,
    createProjectOrderIntentTracker,
    PROJECT_DRAG_TYPE,
    projectMoveBetween,
    projectOrderAfterDrop,
    projectReorderTargets,
    sortByProjectOrder,
} from '../project-order';
import { useHeldProjectOrder } from './use-held-project-order';

interface ProjectOrderController {
    draggedProjectId?: string;
    endDrag: () => void;
    move: (projectId: string, title: string, delta: -1 | 1) => void;
    onListDragOver: (event: DragEvent<HTMLElement>) => void;
    /**
     * The pointer entering or leaving the Project list; a Server re-sort is held back while it is inside.
     */
    onListPointerChange: (isInside: boolean) => void;
    /**
     * The Projects in the order the sidebar draws them: held steady while the pointer is in the list or a drag is
     * active, then caught up to the Server order.
     */
    orderedProjectIds: readonly string[];
    projectDropTarget?: ProjectDropTarget;
    projectOrderAnnouncement: string;
    startDrag: (event: DragEvent<HTMLElement>, projectId: string) => void;
    updateDropTarget: (event: DragEvent<HTMLElement>, projectId: string) => void;
    drop: (event: DragEvent<HTMLElement>, targetProjectId: string) => void;
}

export function useProjectOrder(
    serverProjects: ProjectRecord[],
    mergedProjects: readonly MergedProject[],
): ProjectOrderController {
    // The queue worker outlives renders, so it reads the latest headings through a ref.
    const mergedProjectsReference = useRef(mergedProjects);
    useEffect(() => {
        mergedProjectsReference.current = mergedProjects;
    }, [mergedProjects]);
    const [draggedProjectId, setDraggedProjectId] = useState<string>();
    const [projectDropTarget, setProjectDropTarget] = useState<ProjectDropTarget>();
    const [projectOrderAnnouncement, setProjectOrderAnnouncement] = useState('');
    const [isPointerInside, setIsPointerInside] = useState(false);
    const [releaseKey, setReleaseKey] = useState(0);
    const serverProjectIds = serverProjects.map((project) => project.id);
    const orderedProjectIds = useHeldProjectOrder(
        serverProjectIds,
        isPointerInside || draggedProjectId !== undefined,
        releaseKey,
    );
    const projects = sortByProjectOrder(serverProjects, orderedProjectIds, (project) => project.id);
    const previousOrderReference = useRef(orderedProjectIds);
    const skipRunningAnnouncementReference = useRef(false);
    const intentTrackerReference = useRef<
        ReturnType<typeof createProjectOrderIntentTracker> | undefined
    >(undefined);
    intentTrackerReference.current ??= createProjectOrderIntentTracker();
    const queueReference = useRef<ReturnType<typeof createLatestProjectOrderQueue> | undefined>(
        undefined,
    );

    useEffect(() => {
        queueReference.current = createLatestProjectOrderQueue(async (projectIds) => {
            const intent = intentTrackerReference.current?.get();
            if (intent?.projectIds !== projectIds) return;
            const members = new Map(
                mergedProjectsReference.current.map((entry) => [
                    entry.id,
                    entry.members.map((member) => member.id),
                ]),
            );
            let isReordered = true;
            // One call per machine holding a member: each Server orders its own Projects, merged members included.
            const targets = projectReorderTargets(
                projectIds,
                intent.movedProjectId,
                (headingId) => members.get(headingId),
                environmentOfProject,
            );
            for (const target of targets) {
                // eslint-disable-next-line no-await-in-loop -- sequential: stop at the first rejected machine
                isReordered = await didReorderProject(target.projectId, target.targetIndex);
                if (!isReordered) break;
            }
            intentTrackerReference.current?.settle(isReordered);
        });
        return () => {
            queueReference.current = undefined;
        };
    }, []);

    useEffect(() => {
        const confirmed = intentTrackerReference.current?.reconcile(
            serverProjects.map((project) => project.id),
        );
        if (!confirmed) return;
        // The user's own reorder must show at once even though the pointer is still over the list.
        skipRunningAnnouncementReference.current = true;
        setReleaseKey((key) => key + 1);
        setProjectOrderAnnouncement(
            translate('primarySidebar.projectOrder.movedAnnouncement', {
                position: confirmed.projectIds.indexOf(confirmed.movedProjectId) + 1,
                title: confirmed.title,
                total: confirmed.projectIds.length,
            }),
        );
    }, [serverProjects]);

    useEffect(() => {
        const previous = previousOrderReference.current;
        previousOrderReference.current = orderedProjectIds;
        if (skipRunningAnnouncementReference.current) {
            skipRunningAnnouncementReference.current = false;
            return;
        }
        const move = projectMoveBetween(previous, orderedProjectIds);
        const moved = move && projects.find((project) => project.id === move.movedProjectId);
        if (!move || !moved) return;
        // An Agent starting or stopping re-sorts the list; announce it since the held order delays it visually.
        setProjectOrderAnnouncement(
            translate('primarySidebar.projectOrder.movedAnnouncement', {
                position: move.position,
                title: moved.title,
                total: move.total,
            }),
        );
        // A rerun for new Server records with the same order finds no move, so only an order change announces.
    }, [orderedProjectIds, projects]);

    const enqueue = (projectIds: string[], movedProjectId: string, title: string): void => {
        intentTrackerReference.current?.set({ title, movedProjectId, projectIds });
        // Fire-and-forget: the queue's async worker persists this order and settles the intent
        // tracker internally; this handler has no UI result to await here.
        void queueReference.current?.enqueue(projectIds);
    };

    const currentProjectIds = (): string[] =>
        intentTrackerReference.current?.get()?.projectIds ?? projects.map((project) => project.id);

    const commit = (projectIds: string[], movedProjectId: string, title: string): void => {
        const currentIds = currentProjectIds();
        if (
            projectIds.length === currentIds.length &&
            projectIds.every((projectId, index) => projectId === currentIds[index])
        )
            return;
        enqueue(projectIds, movedProjectId, title);
    };

    const dropEdge = (
        event: DragEvent<HTMLElement>,
        projectId: string,
    ): ProjectDropTarget | undefined => {
        const draggedId = event.dataTransfer.getData(PROJECT_DRAG_TYPE) || draggedProjectId;
        if (!draggedId || draggedId === projectId) return undefined;
        const bounds = event.currentTarget.getBoundingClientRect();
        return {
            edge: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
            projectId,
        };
    };

    const endDrag = (): void => {
        setDraggedProjectId(undefined);
        setProjectDropTarget(undefined);
    };

    return {
        draggedProjectId,
        endDrag,
        move(projectId, title, delta) {
            const reordered = adjacentProjectOrder(currentProjectIds(), projectId, delta);
            if (reordered) enqueue(reordered, projectId, title);
        },
        onListDragOver(event) {
            const target = event.target;
            if (!(target instanceof Element) || !target.closest('.project-heading'))
                setProjectDropTarget(undefined);
        },
        onListPointerChange: setIsPointerInside,
        orderedProjectIds,
        projectDropTarget,
        projectOrderAnnouncement,
        startDrag(event, projectId) {
            const project = projects.find((candidate) => candidate.id === projectId);
            if (!project) return;
            event.dataTransfer.effectAllowed = 'copyMove';
            event.dataTransfer.setData(PROJECT_DRAG_TYPE, projectId);
            event.dataTransfer.setData(PROJECT_PATH_DRAG_TYPE, project.rootPath);
            event.dataTransfer.setData('text/plain', project.rootPath);
            const preview =
                event.currentTarget.parentElement?.querySelector('.project-drag-preview');
            if (preview instanceof HTMLElement) event.dataTransfer.setDragImage(preview, 14, 14);
            setDraggedProjectId(projectId);
            setProjectDropTarget(undefined);
        },
        updateDropTarget(event, projectId) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            const target = dropEdge(event, projectId);
            setProjectDropTarget((current) =>
                areProjectDropTargetsEqual(current, target) ? current : target,
            );
        },
        drop(event, targetProjectId) {
            event.preventDefault();
            const draggedId = event.dataTransfer.getData(PROJECT_DRAG_TYPE) || draggedProjectId;
            const target = dropEdge(event, targetProjectId);
            endDrag();
            if (!draggedId || !target) return;
            const reordered = projectOrderAfterDrop(
                currentProjectIds(),
                draggedId,
                target.projectId,
                target.edge,
            );
            const draggedProject = projects.find((project) => project.id === draggedId);
            if (draggedProject) commit(reordered, draggedProject.id, draggedProject.title);
        },
    };
}
