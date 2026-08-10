import type { DragEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ProjectRecord } from '@shared/types';

import { reorderProject } from '../session/session-actions';
import {
    adjacentProjectOrder,
    createLatestProjectOrderQueue,
    createProjectOrderIntentTracker,
    PROJECT_DRAG_TYPE,
    projectDropTargetsEqual,
    projectOrderAfterDrop,
    type ProjectDropTarget,
} from './project-order';

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
    const intentTrackerRef = useRef<ReturnType<typeof createProjectOrderIntentTracker> | undefined>(
        undefined,
    );
    intentTrackerRef.current ??= createProjectOrderIntentTracker();
    const queueRef = useRef<ReturnType<typeof createLatestProjectOrderQueue> | undefined>(
        undefined,
    );

    useEffect(() => {
        queueRef.current = createLatestProjectOrderQueue(async (projectIds) => {
            const intent = intentTrackerRef.current?.get();
            if (intent?.projectIds !== projectIds) return;
            const reordered = await reorderProject(
                intent.movedProjectId,
                projectIds.indexOf(intent.movedProjectId),
            );
            intentTrackerRef.current?.settle(reordered);
        });
        return () => {
            queueRef.current = undefined;
        };
    }, []);

    useEffect(() => {
        const confirmed = intentTrackerRef.current?.reconcile(
            projects.map((project) => project.id),
        );
        if (!confirmed) return;
        setProjectOrderAnnouncement(
            `Moved ${confirmed.displayTitle} to position ${confirmed.projectIds.indexOf(confirmed.movedProjectId) + 1} of ${confirmed.projectIds.length}`,
        );
    }, [projects]);

    const enqueue = (projectIds: string[], movedProjectId: string, displayTitle: string): void => {
        intentTrackerRef.current?.set({ displayTitle, movedProjectId, projectIds });
        void queueRef.current?.enqueue(projectIds);
    };

    const currentProjectIds = (): string[] =>
        intentTrackerRef.current?.get()?.projectIds ?? projects.map((project) => project.id);

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
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(PROJECT_DRAG_TYPE, projectId);
            event.dataTransfer.setData('text/plain', projectId);
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
                projectDropTargetsEqual(current, target) ? current : target,
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
