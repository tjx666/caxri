import type { TranslatedNamespace } from '@caxri/protocol';

import type { updates as source } from '../en/updates';

export const updates: TranslatedNamespace<typeof source> = {
    // Update dialog
    'updates.dialog.title': '软件更新',
    'updates.dialog.description': 'Caxri 从官方 GitHub Release 下载更新。',
    'updates.dialog.downloadProgress': '更新下载进度',
    'updates.dialog.unsignedNotice':
        'Caxri 目前未签名。打开已验证的 DMG 后，将 Caxri 拖到“应用程序”文件夹并确认替换现有应用。下载过程不会中断正在运行的终端。',
    'updates.dialog.skipVersion': '跳过此版本',
    'updates.action.checking': '正在检查…',
    'updates.action.stopSkipping': '取消跳过',
    'updates.action.download': '下载更新',
    'updates.action.cancelDownload': '取消下载',
    'updates.action.openDmg': '打开 DMG',
    'updates.action.retryDownload': '重新下载',
    'updates.action.checkAgain': '再次检查',

    // Commands and notifications
    'updates.error.check': '无法检查更新',
    'updates.error.download': '无法下载更新',
    'updates.error.cancel': '无法取消更新下载',
    'updates.error.open': '无法打开更新',
    'updates.error.skip': '无法跳过此版本',
    'updates.error.stopSkipping': '无法取消跳过此版本',
    'updates.skipped': '在发布更新的版本之前，Caxri 不会再提示 {{version}}。可在设置中撤销。',
    'updates.announcement.message': 'Caxri {{version}} 已可用。当前版本为 {{currentVersion}}。',
    'updates.announcement.showLabel': '查看 Caxri {{version}} 更新',

    // Dialog status copy
    'updates.status.loading.title': '正在加载更新状态…',
    'updates.status.loading.description': '请稍候。',
    'updates.status.version': 'Caxri {{version}}',
    'updates.status.idle.description': '在 GitHub Releases 中检查是否有更新的稳定版本。',
    'updates.status.checking.title': '正在检查更新…',
    'updates.status.unavailable.title': '无法检查更新',
    'updates.status.paused.title': '更新检查已暂停',
    'updates.status.paused.description':
        '{{reason}} {{resume}}立即检查会直接请求 GitHub，无需等待。',
    'updates.status.paused.resumesAt': '自动检查将在 {{time}} 后恢复。',
    'updates.status.paused.resumesLater': '自动检查将在限制解除后恢复。',
    'updates.status.upToDate.title': 'Caxri 已是最新版本',
    'updates.status.upToDate.description': '你正在使用最新版本 {{version}}。',
    'updates.status.available.title': 'Caxri {{version}} 已可用',
    'updates.status.available.skippedDescription':
        '你已跳过此版本，因此 Caxri 不再提示。取消跳过即可下载 {{fileName}} 并在此验证。',
    'updates.status.available.description': '在 Caxri 中下载 {{fileName}}，并在打开前完成验证。',
    'updates.status.downloading.title': '正在下载 Caxri {{version}}…',
    'updates.status.downloading.progress': '{{received}} / {{total}}',
    'updates.status.downloading.received': '已下载 {{received}}',
    'updates.status.ready.title': 'Caxri {{version}} 已可安装',
    'updates.status.ready.description': 'DMG 已通过 SHA-256 校验。',
    'updates.status.error.title': '更新失败',
    'updates.status.error.network': '更新连接已中断。请检查网络后重试。',
    'updates.status.error.integrity': '下载的文件未通过验证，未予打开。请重新下载。',
    'updates.status.error.open': '无法打开已下载的安装包。请重试，或在“访达”中打开。',
    'updates.status.error.generic': '无法完成更新。请重试。',

    // Status bar chip
    'updates.chip.available.label': '更新 {{version}}',
    'updates.chip.available.description': 'Caxri {{version}} 已可用。点击查看更新。',
    'updates.chip.downloading.label': '正在更新…',
    'updates.chip.downloading.labelPercent': '正在更新 {{percent}}%',
    'updates.chip.downloading.description': '正在下载 Caxri {{version}}。点击查看下载。',
    'updates.chip.ready.label': '更新已就绪',
    'updates.chip.ready.description': 'Caxri {{version}} 已下载并通过验证。点击进行安装。',
    'updates.chip.failed.label': '更新失败',
    'updates.chip.failed.installDescription': 'Caxri {{version}} 安装失败。点击查看原因并重试。',
    'updates.chip.failed.downloadDescription': 'Caxri {{version}} 下载失败。点击查看原因并重试。',
};
