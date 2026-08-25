import { Empty } from '../../../components/ui/empty';
import { GitRepoSection } from './git-repo-section';
import { submoduleRepositoriesByPath } from './git-tree';
import { SourceControlHeader } from './source-control-header';
import type { SourceControlController } from './use-source-control-controller';

export function SourceControlContent({ controller }: { controller: SourceControlController }) {
    if (controller.status === 'empty')
        return (
            <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">
                {controller.message}
            </Empty>
        );

    const {
        activeDiff,
        flashedRepoId,
        focusRepository,
        mode,
        navigation,
        pullRequestRefresh,
        repositoriesRef,
        session,
        setDirectoryExpanded,
        setRepositoryExpanded,
        summary,
    } = controller;

    return (
        <div className="secondary-sidebar-content git-panel flex min-h-0 flex-1 flex-col overflow-hidden">
            <SourceControlHeader mode={mode} />
            <div
                ref={repositoriesRef}
                className="git-repositories min-h-0 flex-1 overflow-auto border-b border-border"
                aria-label="Git repositories"
            >
                {summary.repositories.map((repo) => (
                    <GitRepoSection
                        key={repo.id}
                        repository={repo}
                        activeDiff={activeDiff}
                        expanded={navigation.expandedRepositories[repo.id] ?? true}
                        expandedDirectories={navigation.expandedDirectories}
                        flashed={flashedRepoId === repo.id}
                        mode={mode}
                        submodulesByPath={submoduleRepositoriesByPath(repo, summary.repositories)}
                        onFocusRepository={focusRepository}
                        onExpandedChange={(isExpanded) =>
                            setRepositoryExpanded(repo.id, isExpanded)
                        }
                        pullRequestRefresh={pullRequestRefresh}
                        sessionId={session.id}
                        setDirectoryExpanded={setDirectoryExpanded}
                    />
                ))}
            </div>
        </div>
    );
}
