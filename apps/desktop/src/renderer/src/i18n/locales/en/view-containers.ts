import { viewContainersFiles } from './view-containers-files';
import { viewContainersSourceControl } from './view-containers-source-control';

/**
 * View container strings: the shared surface and extension tree views here, Files and Source Control in their own
 * modules so each stays reviewable.
 */
export const viewContainers = {
    'viewContainers.surface.loading': 'Loading views…',
    'viewContainers.surface.loadFailed': 'Unable to load views.',
    'viewContainers.surface.extensionUnavailable': 'Extension unavailable',
    'viewContainers.surface.retryExtensionFailed': 'Unable to retry extension',
    'viewContainers.extensionFailure.interrupted':
        'The connection to this view was interrupted. Retry to reconnect.',
    'viewContainers.extensionFailure.timeout': 'This view did not respond in time. Try again.',
    'viewContainers.extensionFailure.busy': 'This view is busy. Wait a moment, then try again.',
    'viewContainers.extensionFailure.denied':
        'This view does not have access to this operation or Project.',
    'viewContainers.extensionFailure.tooLarge': 'This view returned more data than it can display.',
    'viewContainers.extensionFailure.generic': 'This view could not load. Try again.',
    'viewContainers.extensionTree.refresh': 'Refresh {{title}}',
    'viewContainers.extensionTree.noSession': 'Select a Session to load this view.',
    'viewContainers.extensionTree.loading': 'Loading view…',
    'viewContainers.extensionTree.loadFailed': 'Unable to load {{title}}',
    'viewContainers.extensionTree.empty': 'No items in this view.',
    'viewContainers.extensionTree.collapseItem': 'Collapse {{label}}',
    'viewContainers.extensionTree.expandItem': 'Expand {{label}}',
    'viewContainers.extensionTree.actionsHint':
        'Actions: {{names}}. Press Right Arrow to reach them, or Shift+F10 for a menu.',
    'viewContainers.extensionTree.actionsHintCollapsed':
        'Actions: {{names}}. Press Right Arrow to expand the row, then Right Arrow again to reach them, or Shift+F10 for a menu.',
    'viewContainers.extensionTree.openTooltipLink': 'Open {{label}}: {{value}}',
    'viewContainers.extensionTree.stateSaveFailed': 'Extension tree state could not be saved',
    'viewContainers.commands.runFailed': 'Unable to run {{title}}',
    'viewContainers.commands.linkMissing': 'Unable to run {{title}}. The link is missing.',
    'viewContainers.commands.promptMissing': '{{failure}}. The prompt is missing.',
    'viewContainers.commands.sentToAgent': 'Sent to {{agent}}',
    'viewContainers.commands.loadFailed': 'Unable to load extension commands',
    'viewContainers.commands.unknown': 'Unknown command: {{commandId}}',
    // Built-in container and view titles, translated by id (see view-container-labels.ts)
    'viewContainers.builtin.files': 'Files',
    'viewContainers.builtin.info': 'Info',
    'viewContainers.builtin.logs': 'Logs',
    ...viewContainersFiles,
    ...viewContainersSourceControl,
} as const;
