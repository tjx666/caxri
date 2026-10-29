import type { TranslatedNamespace } from '@caxri/protocol';

import type { viewContainersExtensionText as source } from '../en/view-containers-extension-text';

export const viewContainersExtensionText: TranslatedNamespace<typeof source> = {
    'viewContainers.extensionText.sourceControl.title': '源代码管理',
    'viewContainers.extensionText.sourceControl.repositories': 'Git 仓库',
    'viewContainers.extensionText.sourceControl.mode': '源代码管理模式',
    'viewContainers.extensionText.sourceControl.modeWorking': '工作区更改',
    'viewContainers.extensionText.sourceControl.modeLastCommit': '最近一次提交的更改',
    'viewContainers.extensionText.sourceControl.modeCommit': '提交更改（{{sha}}）',
    'viewContainers.extensionText.sourceControl.modePullRequest': 'Pull Request 的更改',
    'viewContainers.extensionText.sourceControl.refreshPullRequest': '刷新 Pull Request',
    'viewContainers.extensionText.sourceControl.refreshGit': '刷新 Git',
    'viewContainers.extensionText.sourceControl.hideExcluded': '隐藏已排除的文件（{{count}}）',
    'viewContainers.extensionText.sourceControl.showExcluded': '显示已排除的文件（{{count}}）',
    'viewContainers.extensionText.sourceControl.groupChanges': '更改',
    'viewContainers.extensionText.sourceControl.groupLastCommit': '最近一次提交',
    'viewContainers.extensionText.sourceControl.groupCommit': '提交 {{sha}}',
    'viewContainers.extensionText.sourceControl.groupPullRequest': 'PR #{{number}} 的更改',
    'viewContainers.extensionText.sourceControl.fileHistory': '文件历史',
    'viewContainers.extensionText.sourceControl.fileHistoryEmpty': '打开文件以查看其历史。',
    'viewContainers.extensionText.sourceControl.commits': '提交',
    'viewContainers.extensionText.sourceControl.historyPathFor': '{{name}} 的历史路径',
    'viewContainers.extensionText.sourceControl.historyPathPlaceholder': '历史路径（可选）',
    'viewContainers.extensionText.sourceControl.historyPathClear': '清除历史路径',
    'viewContainers.extensionText.sourceControl.loadingFileHistory': '正在加载文件历史…',
    'viewContainers.extensionText.sourceControl.loadingCommits': '正在加载提交…',
    'viewContainers.extensionText.sourceControl.noFileHistory': '没有文件历史。',
    'viewContainers.extensionText.sourceControl.noCommits': '没有提交。',
    'viewContainers.extensionText.sourceControl.loadMoreCommits': '加载更多提交',
    'viewContainers.extensionText.sourceControl.loadingMore': '正在加载…',
    'viewContainers.extensionText.sourceControl.fileHistoryLoadFailed': '无法加载文件历史',
    'viewContainers.extensionText.sourceControl.commitsLoadFailed': '无法加载提交',
    'viewContainers.extensionText.sourceControl.loadingCommit': '正在加载提交…',
    'viewContainers.extensionText.sourceControl.commitLoadFailed': '无法加载提交',
    'viewContainers.extensionText.sourceControl.changedFiles': '更改的文件',
    'viewContainers.extensionText.sourceControl.noFilesInScope': '此范围内没有文件。',
    'viewContainers.extensionText.sourceControl.fileListTruncated': '文件列表已截断。',
    'viewContainers.extensionText.sourceControl.commitPrefix': '提交',
    'viewContainers.extensionText.sourceControl.noSubject': '（无主题）',
    'viewContainers.extensionText.sourceControl.openChangesIn': '打开 {{path}} 中的更改',
    'viewContainers.extensionText.sourceControl.discardFailed': '放弃更改失败',
    'viewContainers.extensionText.sourceControl.deleteFile': '删除文件',
    'viewContainers.extensionText.sourceControl.discardChanges': '放弃更改',
    'viewContainers.extensionText.sourceControl.deleteNamed': '删除 {{name}}',
    'viewContainers.extensionText.sourceControl.discardChangesIn': '放弃 {{name}} 中的更改',
    'viewContainers.extensionText.sourceControl.discardAll': '放弃所有更改',
    'viewContainers.extensionText.sourceControl.discardAllNotLoaded':
        '部分更改尚未加载。请先显示已排除的文件，再放弃所有更改。',
    'viewContainers.extensionText.sourceControl.discardAllExcluded':
        '请先显示已排除的文件，再放弃所有更改。',
    'viewContainers.extensionText.sourceControl.openPullRequestChanges': '打开 Pull Request 的更改',
    'viewContainers.extensionText.sourceControl.openWorkingTreeChanges': '打开工作区更改',
    'viewContainers.extensionText.sourceControl.openChanges': '打开更改',
    'viewContainers.extensionText.sourceControl.openPullRequestOnWeb':
        '在网页上打开 Pull Request #{{number}}',
    'viewContainers.extensionText.sourceControl.syncIn': '同步 {{name}} 中的更改',
    'viewContainers.extensionText.sourceControl.syncing': '正在同步 {{name}}',
    'viewContainers.extensionText.sourceControl.syncFailed': '同步失败',
    'viewContainers.extensionText.sourceControl.syncTooltip': '同步更改（先拉取，再推送）',
    'viewContainers.extensionText.sourceControl.upToDate': '已是最新',
    'viewContainers.extensionText.sourceControl.synced': '已与远程同步',
    'viewContainers.extensionText.sourceControl.workingTreeClean': '工作区没有更改。',
    'viewContainers.extensionText.sourceControl.noCommitsYet': '还没有任何提交。',
    'viewContainers.extensionText.sourceControl.commitUnableNamed': '无法加载提交 {{sha}}。',
    'viewContainers.extensionText.sourceControl.commitUnableLast': '无法加载最近一次提交。',
    'viewContainers.extensionText.sourceControl.commitNoChangesNamed':
        '提交 {{sha}} 没有文件更改。',
    'viewContainers.extensionText.sourceControl.commitLoadingNamed': '正在加载提交 {{sha}}…',
    'viewContainers.extensionText.sourceControl.commitNoChangesLast': '最近一次提交没有文件更改。',
    'viewContainers.extensionText.sourceControl.commitLoadingLast': '正在加载最近一次提交…',
    'viewContainers.extensionText.sourceControl.detachedNoPullRequest':
        '分离的 HEAD 没有 Pull Request。切换到某个分支后才能查看。',
    'viewContainers.extensionText.sourceControl.pullRequestLoadFailed':
        '无法加载 Pull Request 的更改。请刷新后重试。',
    'viewContainers.extensionText.sourceControl.noPullRequest': '此分支没有 Pull Request。',
    'viewContainers.extensionText.sourceControl.pullRequestNoChanges':
        'Pull Request 没有文件更改。',
    'viewContainers.extensionText.sourceControl.pullRequestLoading':
        '正在加载 Pull Request 的更改…',
    'viewContainers.extensionText.sourceControl.excludedHiddenOne':
        '已隐藏 {{count}} 个已排除的文件。',
    'viewContainers.extensionText.sourceControl.excludedHiddenOther':
        '已隐藏 {{count}} 个已排除的文件。',
    'viewContainers.extensionText.sourceControl.truncatedChanges':
        '显示前 {{shown}} 项，共 {{total}} 项更改',
    'viewContainers.extensionText.sourceControl.truncatedCommitFiles':
        '显示此提交的前 {{count}} 个文件',
    'viewContainers.extensionText.sourceControl.truncatedPayload':
        '此工作区超出了显示上限，部分源代码管理内容已隐藏。',
    'viewContainers.extensionText.sourceControl.notRepository': '此文件夹不是 Git 仓库。',
    'viewContainers.extensionText.sourceControl.unavailable': '源代码管理当前不可用。',
    'viewContainers.extensionText.sourceControl.unavailableWithError':
        '源代码管理当前不可用。{{error}}',
    'viewContainers.extensionText.sourceControl.noApprovedRepositories':
        '没有找到已授权的 Git 仓库。',
    'viewContainers.extensionText.sourceControl.detachedHead': '分离的 HEAD',
    'viewContainers.extensionText.sourceControl.detachedHeadAt': '分离的 HEAD，位于 {{ref}}',
    'viewContainers.extensionText.sourceControl.detachedBadge': '已分离',
    'viewContainers.extensionText.sourceControl.ahead': '领先 {{count}}',
    'viewContainers.extensionText.sourceControl.behind': '落后 {{count}}',
    'viewContainers.extensionText.sourceControl.tracking': '跟踪 {{ref}}',
    'viewContainers.extensionText.sourceControl.pullRequestInto':
        'Pull Request #{{number}} 合并到 {{base}}：{{title}}',
    'viewContainers.extensionText.sourceControl.unpushedLocalOne':
        '{{count}} 个本地提交未包含在 Pull Request #{{number}} 中',
    'viewContainers.extensionText.sourceControl.unpushedLocalOther':
        '{{count}} 个本地提交未包含在 Pull Request #{{number}} 中',
    'viewContainers.extensionText.sourceControl.kindWorktree': 'Worktree',
    'viewContainers.extensionText.sourceControl.kindNested': '嵌套',
    'viewContainers.extensionText.sourceControl.kindSubmodule': '子模块',
    'viewContainers.extensionText.sourceControl.countUnavailable': '不可用',
    'viewContainers.extensionText.sourceControl.countUnpushed': '{{count}} 个未推送',
    'viewContainers.extensionText.sourceControl.countUncommitted': '{{count}} 个未提交',
    'viewContainers.extensionText.sourceControl.uncommittedOne':
        '{{name}} 中有 {{count}} 项未提交的更改',
    'viewContainers.extensionText.sourceControl.uncommittedOther':
        '{{name}} 中有 {{count}} 项未提交的更改',
    'viewContainers.extensionText.sourceControl.uncommittedShowOne':
        '{{name}} 中有 {{count}} 项未提交的更改。点击查看工作区更改。',
    'viewContainers.extensionText.sourceControl.uncommittedShowOther':
        '{{name}} 中有 {{count}} 项未提交的更改。点击查看工作区更改。',
    'viewContainers.extensionText.sourceControl.filesChangedOne': '{{count}} 个文件已更改',
    'viewContainers.extensionText.sourceControl.filesChangedOther': '{{count}} 个文件已更改',
    'viewContainers.extensionText.sourceControl.hiddenCount': '{{count}} 个已隐藏',
    'viewContainers.extensionText.status.noRepository': '没有 Git 仓库',
    'viewContainers.extensionText.status.initializeRepository':
        '请在项目根目录中初始化 Git 仓库，然后刷新。',
    'viewContainers.extensionText.status.unavailable': '项目状态不可用',
    'viewContainers.extensionText.status.noRepositories': '未找到仓库',
    'viewContainers.extensionText.status.addRepository': '请为此项目添加一个 Git 仓库，然后刷新。',
    'viewContainers.extensionText.status.refresh': '刷新',
    'viewContainers.extensionText.status.openLogs': '打开日志',
    'viewContainers.extensionText.status.deployments': '部署',
    'viewContainers.extensionText.status.noNetwork': '没有网络连接',
    'viewContainers.extensionText.status.rowBranch': '分支',
    'viewContainers.extensionText.status.rowRepository': '仓库',
    'viewContainers.extensionText.status.rowPullRequest': 'Pull Request',
    'viewContainers.extensionText.status.rowComparedBranch': '对比分支',
    'viewContainers.extensionText.status.rowChecked': '检查时间',
    'viewContainers.extensionText.status.rowDefault': '默认',
    'viewContainers.extensionText.status.rowChecks': '检查',
    'viewContainers.extensionText.status.rowMerge': '合并',
    'viewContainers.extensionText.status.rowHidden': '已隐藏',
    'viewContainers.extensionText.status.publicationChecking': '正在检查 origin…',
    'viewContainers.extensionText.status.publicationUnpublished': '不在 origin 上',
    'viewContainers.extensionText.status.publicationPublished': '在 origin 上',
    'viewContainers.extensionText.status.publicationSynced': '已同步',
    'viewContainers.extensionText.status.publicationUnknown': '检查失败',
    'viewContainers.extensionText.status.publicationNoOrigin': '没有 origin',
    'viewContainers.extensionText.status.publicationUnsupported': '不支持',
    'viewContainers.extensionText.status.publicationUnborn': '没有提交',
    'viewContainers.extensionText.status.descUnpublished':
        'origin 上没有同名分支。它可能存在于其他远程仓库，或使用了其他名称。',
    'viewContainers.extensionText.status.descPublished':
        '该分支存在于 origin，但本地历史不足以比较提交。这并不能确认每个本地提交都已推送。',
    'viewContainers.extensionText.status.descSynced':
        '检查时，本地分支与 origin 分支的最新提交一致。',
    'viewContainers.extensionText.status.descAhead':
        '检查时，本地有提交不在所对比的 origin 分支上。',
    'viewContainers.extensionText.status.descBehind': '检查时，origin 上有提交不在本地分支上。',
    'viewContainers.extensionText.status.descDiverged': '检查时，两个分支各有对方没有的提交。',
    'viewContainers.extensionText.status.descUnknown':
        '无法验证 origin 上的分支。请刷新项目状态后重新检查。',
    'viewContainers.extensionText.status.descUnsupported': '远程验证目前只支持 GitHub 的 origin。',
    'viewContainers.extensionText.status.descNoOrigin':
        '项目状态会把此分支与名为 origin 的 GitHub 远程仓库对比，而此仓库没有。请用 `git remote add origin <url>` 添加后刷新。',
    'viewContainers.extensionText.status.descDetached': 'HEAD 没有指向本地分支。',
    'viewContainers.extensionText.status.descUnborn': '此分支还没有任何提交。',
    'viewContainers.extensionText.status.descChecking': '正在检查 origin 上的同名分支。',
    'viewContainers.extensionText.status.noDeployments': '未找到 Vercel 部署',
    'viewContainers.extensionText.status.noDeploymentsHint':
        '此仓库已关联 Vercel，但没有找到匹配的部署。请先创建一个，然后重新检查。',
    'viewContainers.extensionText.status.cliNotInstalled': '未安装 {{provider}}',
    'viewContainers.extensionText.status.cliNotSignedIn': '{{provider}} 未登录',
    'viewContainers.extensionText.status.cliNotLinked': '{{provider}} 未关联',
    'viewContainers.extensionText.status.vercelNotLinked': '仓库未关联 Vercel',
    'viewContainers.extensionText.status.cliAccessDenied': '{{provider}} 拒绝访问',
    'viewContainers.extensionText.status.cliConnectionFailed': '{{provider}} 连接失败',
    'viewContainers.extensionText.status.cliTlsFailed': '{{provider}} 安全连接失败',
    'viewContainers.extensionText.status.apiLimitReached': '已达到 {{service}} API 限额',
    'viewContainers.extensionText.status.cliTimedOut': '{{provider}} 超时',
    'viewContainers.extensionText.status.cliFailed': '{{provider}} 出错',
    'viewContainers.extensionText.status.cliSubjectFailed': '{{provider}}：{{subject}} 失败',
    'viewContainers.extensionText.status.installGitHub':
        '此仓库的 Pull Request 需要 GitHub CLI。请安装后重新检查。',
    'viewContainers.extensionText.status.installLobeHub':
        '验收报告需要 LobeHub CLI。请用 npm i -g @lobehub/cli 安装后重新检查。',
    'viewContainers.extensionText.status.installLinear':
        '关联的议题需要 Linear CLI。请安装后重新检查。',
    'viewContainers.extensionText.status.installVercel':
        '此仓库的部署需要 Vercel CLI。请用 npm i -g vercel 安装后重新检查。',
    'viewContainers.extensionText.status.signInHint':
        '请在终端中运行 {{command}}，然后重新检查。仅设置 {{variable}} 环境变量不够，Caxri 不会把你 shell 中的个人凭据转交给 CLI 检查。',
    'viewContainers.extensionText.status.linkLinear':
        '请在此仓库中运行 linear config，然后重新检查。',
    'viewContainers.extensionText.status.linkVercel': '请在此仓库中运行 vc link，然后重新检查。',
    'viewContainers.extensionText.status.linkGeneric': '请为此仓库配置 {{service}}，然后重新检查。',
    'viewContainers.extensionText.status.accessGitHub':
        '请运行 gh auth refresh；如果组织要求，请授权 SSO，然后重新检查。',
    'viewContainers.extensionText.status.accessLobeHub':
        '请确认你的 LobeHub 账号可以读取此报告，然后重新检查。',
    'viewContainers.extensionText.status.accessLinear':
        '请确认你的 Linear 账号可以访问此团队，然后重新检查。',
    'viewContainers.extensionText.status.accessVercel':
        '请确认你的 Vercel 账号可以访问此项目，然后重新检查。',
    'viewContainers.extensionText.status.couldNotReach':
        'Caxri 无法连接 {{provider}}。请检查网络连接，然后重新检查。',
    'viewContainers.extensionText.status.couldNotReachShared':
        'Caxri 无法连接 {{providers}}。请重新联网后刷新。',
    'viewContainers.extensionText.status.tlsHint': '请检查代理或证书，然后重试。',
    'viewContainers.extensionText.status.rateLimitRetry':
        '为保护共享的 API 额度，Caxri 已暂停 {{service}} 检查，将在 {{time}} 之后重试。',
    'viewContainers.extensionText.status.rateLimitRefresh':
        '为保护共享的 API 额度，Caxri 已暂停 {{service}} 检查。请在限额重置后刷新。',
    'viewContainers.extensionText.status.timeoutHint': '请检查网络或代理，然后刷新。',
    'viewContainers.extensionText.status.failedPullRequests':
        '加载 Pull Request 时出错。请打开日志查看详情。',
    'viewContainers.extensionText.status.failedAcceptance':
        '加载验收报告时出错。请打开日志查看详情。',
    'viewContainers.extensionText.status.failedIssues': '加载关联议题时出错。请打开日志查看详情。',
    'viewContainers.extensionText.status.failedDeployments': '加载部署时出错。请打开日志查看详情。',
    'viewContainers.extensionText.status.statePassed': '已通过',
    'viewContainers.extensionText.status.stateFailed': '失败',
    'viewContainers.extensionText.status.stateCanceled': '已取消',
    'viewContainers.extensionText.status.stateRunning': '运行中',
    'viewContainers.extensionText.status.stateQueued': '排队中',
    'viewContainers.extensionText.status.stateNeutral': '中性',
    'viewContainers.extensionText.status.stateUnknown': '未知',
    'viewContainers.extensionText.status.ciPassed': 'CI 已通过',
    'viewContainers.extensionText.status.ciFailed': 'CI 失败',
    'viewContainers.extensionText.status.ciCanceled': 'CI 已取消',
    'viewContainers.extensionText.status.ciRunning': 'CI 运行中',
    'viewContainers.extensionText.status.ciQueued': 'CI 排队中',
    'viewContainers.extensionText.status.ciNeutral': 'CI 中性',
    'viewContainers.extensionText.status.ciUnknown': 'CI 未知',
};
