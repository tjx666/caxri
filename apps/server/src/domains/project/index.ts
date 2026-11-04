export { addProjectFolder, addProjectFolderWithOutcome, type ProjectAddOutcome } from './add';
export {
    createProjectFolderBrowser,
    hasVisibleChildDirectory,
    isGitRepoRoot,
} from './folder-browse';
export { createProjectHidingHandlers } from './hiding-handlers';
export { resolveOwnerProjectRoot, resolveProjectRoot } from './root-identity';
export { ProjectRootResolver, type ResolvedSessionPath } from './roots';
export { createProjectRunningOrderEvents } from './running-order-events';
export { importProjectTransferFile, writeProjectTransfer } from './transfer';
