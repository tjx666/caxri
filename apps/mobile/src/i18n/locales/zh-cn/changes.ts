import type { TranslatedNamespace } from '@caxri/protocol';

import type { changes as source } from '../en/changes';

export const changes: TranslatedNamespace<typeof source> = {
    'changes.askAgentToCommit': '让 Agent 提交',
    'changes.askAgentToCommitHint': '填入消息草稿。点击发送之前不会发送任何内容。',
    'changes.backToFiles': '返回已更改的文件',
    'changes.diffLoadFailed': '无法加载此差异。',
    'changes.diffLoading': '正在加载差异…',
    'changes.diffOutdated': '此差异已过时。请刷新更改后重新打开文件。',
    'changes.diffReconnect': '重新连接以查看此差异。',
    'changes.diffRetry': '重试加载差异',
    'changes.diffUnavailable': '此文件过大或不是文本。请在电脑上查看。',
    'changes.emptyBody': '此会话的工作树没有更改。',
    'changes.emptyTitle': '没有更改',
    'changes.fileRowLabel':
        '{{filename}}，{{status}}，目录 {{directory}}，仓库 {{repository}}，新增 {{additions}} 行，删除 {{deletions}} 行',
    'changes.fileRowRenamedLabel':
        '{{filename}}，{{status}}（原为 {{originalPath}}），目录 {{directory}}，仓库 {{repository}}，新增 {{additions}} 行，删除 {{deletions}} 行',
    'changes.filesChangedOne': '{{count}} 个文件已更改',
    'changes.filesChangedOther': '{{count}} 个文件已更改',
    'changes.linesAddedOne': '新增 {{count}} 行',
    'changes.linesAddedOther': '新增 {{count}} 行',
    'changes.linesRemoved': '删除 {{count}} 行',
    'changes.loadFailed': '无法加载更改。',
    'changes.loading': '正在加载更改…',
    'changes.noRepositoryBody': '在 Git 项目中打开会话以查看更改。',
    'changes.noRepositoryTitle': '没有 Git 仓库',
    'changes.reconnectToReview': '重新连接以查看更改。',
    'changes.refresh': '刷新更改',
    'changes.refreshFailed': '无法刷新更改，正在显示上次获取的更改。',
    'changes.rootDirectory': '根目录',
    'changes.staleNotice': '连接已断开，正在显示上次获取的更改。',
    'changes.status.added': '已添加',
    'changes.status.deleted': '已删除',
    'changes.status.modified': '已修改',
    'changes.status.renamed': '已重命名',
    'changes.summaryLabel': '{{files}}，{{added}}，{{removed}}',
    'changes.title': '更改',
    'changes.truncated': '仅显示前 {{count}} 项更改。',
};
