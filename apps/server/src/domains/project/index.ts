export { addProjectFolder } from './add';
export {
    createProjectFolderBrowser,
    hasVisibleChildDirectory,
    isGitRepoRoot,
} from './folder-browse';
export { createProjectHidingHandlers } from './hiding-handlers';
export { resolveOwnerProjectRoot, resolveProjectRoot } from './root-identity';
export { ProjectRootResolver, type ResolvedSessionPath } from './roots';
