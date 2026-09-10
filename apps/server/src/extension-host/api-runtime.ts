import { isGlobMatch } from '@caxri/utils';
import {
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    GitPullRequestErrorMessage,
    ProjectStatusSummaryErrorMessage,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState,
} from 'caxri';

/**
 * Runtime values exposed by the native ESM `caxri` module in each extension generation.
 */
export const extensionApiRuntime = {
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    GitPullRequestErrorMessage,
    isGlobMatch,
    ProjectStatusSummaryErrorMessage,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState,
};
