import type {
    ExtensionViewChange,
    ExtensionViewEventContext,
    ViewDescriptor,
} from '@caxri/protocol';

import type { ExtensionHostMessage } from '../../extension-host/protocol';
import { isExtensionViewChangeCompatible } from './view-events';

export interface CatalogChangedEvent {
    revision: number;
    extensionId?: string;
}

export interface TreeChangedEvent {
    viewId: string;
    eventId: string;
    extensionGeneration: number;
    context: ExtensionViewEventContext;
    handles?: string[];
}

export interface ViewChangedEvent {
    viewId: string;
    eventId: string;
    extensionGeneration: number;
    context: ExtensionViewEventContext;
    change: ExtensionViewChange;
}

export function toExtensionViewEventContext(active: {
    sessionId?: string;
    workbenchRootProjectId?: string;
}): ExtensionViewEventContext {
    return active.sessionId && active.workbenchRootProjectId
        ? {
              kind: 'session',
              sessionId: active.sessionId,
              workbenchRootProjectId: active.workbenchRootProjectId,
          }
        : { kind: 'no-session' };
}

export function projectExtensionHostViewEvent(
    event: Extract<ExtensionHostMessage, { type: 'event' }>,
    generation: number | undefined,
    descriptor: ViewDescriptor | undefined,
):
    | { eventName: 'treeChanged' | 'viewChanged'; detail: TreeChangedEvent | ViewChangedEvent }
    | undefined {
    if (
        !descriptor ||
        generation !== event.generation ||
        descriptor.source.kind !== 'extension' ||
        descriptor.source.extensionId !== event.extensionId ||
        (event.event === 'viewChanged' && event.change.kind === 'badge' && !descriptor.badge) ||
        (event.event === 'treeChanged'
            ? descriptor.viewKind.kind !== 'tree'
            : !isExtensionViewChangeCompatible(descriptor.viewKind, event.change))
    )
        return;
    return event.event === 'treeChanged'
        ? {
              eventName: 'treeChanged',
              detail: {
                  viewId: event.viewId,
                  eventId: event.eventId,
                  extensionGeneration: event.generation,
                  context: event.context,
                  ...(event.handles && { handles: event.handles }),
              },
          }
        : {
              eventName: 'viewChanged',
              detail: {
                  viewId: event.viewId,
                  eventId: event.eventId,
                  extensionGeneration: event.generation,
                  context: event.context,
                  change: event.change,
              },
          };
}

export function subscribeExtensionEvent<Detail>(
    target: EventTarget,
    eventName: string,
    listener: (detail: Detail) => void,
): () => void {
    const handler = (event: Event): void => listener((event as CustomEvent<Detail>).detail);
    target.addEventListener(eventName, handler);
    return () => target.removeEventListener(eventName, handler);
}
