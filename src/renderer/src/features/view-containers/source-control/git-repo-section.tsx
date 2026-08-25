import { GitRepoSectionView } from './git-repo-section-view';
import type { GitRepoSectionProperties } from './use-git-repo-section-controller';
import { useGitRepoSectionController } from './use-git-repo-section-controller';

export function GitRepoSection(properties: GitRepoSectionProperties) {
    const controller = useGitRepoSectionController(properties);
    return <GitRepoSectionView controller={controller} />;
}
