import type { DragEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ProjectRecord } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { PROJECT_PATH_DRAG_TYPE } from '../../../lib/file-drag';
import { didReorderProject } from '../../session/session-commands';
import type { ProjectDropTarget } from '../project-order';
import {
    adjacentProjectOrder,
    areProjectDropTargetsEqual,
    createLatestProjectOrderQueue,
    createProjectOrderIntentTracker,
    PROJECT_DRAG_TYPE,
    projectOrderAfterDrop,
} from '../project-order';

interface ProjectOrderController {
    draggedProjectId?: string;
    endDrag: () => void;
    move: (projectId: string, displayTitle: string, delta: -1 | 1) => void;
    onListDragOver: (event: DragEvent<HTMLElement>) => void;
    projectDropTarget?: ProjectDropTarget;
    projectOrderAnnouncement: string;
    startDrag: (event: DragEvent<HTMLElement>, projectId: string) => void;
    updateDropTarget: (event: DragEvent<HTMLElement>, projectId: string) => void;
    drop: (event: DragEvent<HTMLElement>, targetProjectId: string) => void;
}

export function useProjectOrder(projects: ProjectRecord[]): ProjectOrderController {
    const [draggedProjectId, setDraggedProjectId] = useState<string>();
    const [projectDropTarget, setProjectDropTarget] = useState<ProjectDropTarget>();
    const [projectOrderAnnouncement, setProjectOrderAnnouncement] = useState('');
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
            const isReordered = await didReorderProject(
                intent.movedProjectId,
                projectIds.indexOf(intent.movedProjectId),
            );
            intentTrackerReference.current?.settle(isReordered);
        });
        return () => {
            queueReference.current = undefined;
        };
    }, []);

    useEffect(() => {
        const confirmed = intentTrackerReference.current?.reconcile(
            projects.map((project) => project.id),
        );
        if (!confirmed) return;
        setProjectOrderAnnouncement(
            translate('primarySidebar.projectOrder.movedAnnouncement', {
                position: confirmed.projectIds.indexOf(confirmed.movedProjectId) + 1,
                title: confirmed.displayTitle,
                total: confirmed.projectIds.length,
            }),
        );
    }, [projects]);

    const enqueue = (projectIds: string[], movedProjectId: string, displayTitle: string): void => {
        intentTrackerReference.current?.set({ displayTitle, movedProjectId, projectIds });
        // Fire-and-forget: the queue's async worker persists this order and settles the intent
        // tracker internally; this handler has no UI result to await here.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void queueReference.current?.enqueue(projectIds);
    };

    const currentProjectIds = (): string[] =>
        intentTrackerReference.current?.get()?.projectIds ?? projects.map((project) => project.id);

    const commit = (projectIds: string[], movedProjectId: string, displayTitle: string): void => {
        const currentIds = currentProjectIds();
        if (
            projectIds.length === currentIds.length &&
            projectIds.every((projectId, index) => projectId === currentIds[index])
        )
            return;
        enqueue(projectIds, movedProjectId, displayTitle);
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
        move(projectId, displayTitle, delta) {
            const reordered = adjacentProjectOrder(currentProjectIds(), projectId, delta);
            if (reordered) enqueue(reordered, projectId, displayTitle);
        },
        onListDragOver(event) {
            const target = event.target;
            if (!(target instanceof Element) || !target.closest('.project-heading'))
                setProjectDropTarget(undefined);
        },
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
            if (draggedProject) commit(reordered, draggedProject.id, draggedProject.displayTitle);
        },
    };
}
