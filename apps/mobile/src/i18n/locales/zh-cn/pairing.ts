import type { TranslatedNamespace } from '@caxri/protocol';

import type { pairing as source } from '../en/pairing';

export const pairing: TranslatedNamespace<typeof source> = {
    'pairing.allowCamera': '允许访问相机',
    'pairing.allowCameraHint': '请求相机权限以扫描 Caxri 配对码。',
    'pairing.backHint': '返回配对方式选择。',
    'pairing.brandLabel': 'Caxri Mobile',
    'pairing.cameraOptional':
        '相机权限是可选的。你可以选择配对码的截图，或返回后改为粘贴配对链接。',
    'pairing.chooseAnotherMethod': '选择其他配对方式',
    'pairing.choosePhoto': '从相册选择',
    'pairing.choosePhotoHint': '打开相册，从已保存的图片中读取 Caxri 配对码。',
    'pairing.clipboardEmpty': '剪贴板中没有 Caxri 配对链接。',
    'pairing.connectDescription': '连接到电脑上运行的 Caxri。',
    'pairing.error.expired':
        '此配对码已过期。请在电脑上打开 Caxri 的“设置 → 移动设备”，点击“生成配对码”。',
    'pairing.error.failed':
        '配对失败。请在电脑上打开 Caxri 的“设置 → 移动设备”，点击“生成配对码”后重试。',
    'pairing.error.invalidLink': '这不是有效的 Caxri 配对链接。请复制或扫描新的配对码。',
    'pairing.error.rejected':
        '配对被拒绝。配对码仅可使用一次，不能重复使用。请在电脑上打开 Caxri 的“设置 → 移动设备”，点击“生成配对码”后重试。',
    'pairing.error.unreachable':
        '无法连接到 Caxri。请让电脑上的 Caxri 保持运行并开启移动设备访问，然后连接到同一网络；离开家时请使用 Tailscale 或中继服务器。',
    'pairing.error.versionMismatch':
        '需要更新。此应用与电脑上的 Caxri 版本不一致，请将两者都更新到最新版本。',
    'pairing.error.hostOffline': '电脑上的 Caxri 当前离线。请先在电脑上打开 Caxri，然后重试。',
    'pairing.error.relayUnauthorized':
        '中继服务器不接受这台手机。请在电脑上打开 Caxri 的“设置 → 移动设备”，点击“生成配对码”重新配对。',
    'pairing.error.relayBusy': '中继服务器繁忙，请稍后再试。',
    'pairing.failedTitle': '配对失败',
    'pairing.footnote': '在电脑上打开“设置 → 移动设备”，并开启移动设备访问。',
    'pairing.inProgress': '正在配对…',
    'pairing.inProgressLabel': '正在与 Caxri 配对',
    'pairing.noCodeInImage': '该图片中未找到配对码。',
    'pairing.notConnected': '未连接',
    'pairing.notConnectedLabel': '未连接。请将此设备与电脑上的 Caxri 配对。',
    'pairing.openingLink': '正在打开配对链接…',
    'pairing.openSettings': '前往系统设置允许访问相机',
    'pairing.openSettingsHint': '打开此应用的系统设置，可在其中重新开启相机权限。',
    'pairing.pairAgain': '重新配对',
    'pairing.pairingWithCaxri': '正在与 Caxri 配对…',
    'pairing.pairTitle': '与 Caxri 配对',
    'pairing.pasteAndPair': '粘贴并配对',
    'pairing.pasteAndPairHint': '读取并使用剪贴板中的 Caxri 配对链接。',
    'pairing.pasteDescription': '使用电脑上 Caxri“设置 → 移动设备”中“生成配对码”得到的短时效链接。',
    'pairing.pasteHint': '从剪贴板读取 Caxri 配对链接。',
    'pairing.pasteLink': '粘贴配对链接',
    'pairing.revokedDescription':
        '这台手机已在电脑上的 Caxri 中被撤销。请在电脑上打开“设置 → 移动设备”，点击“生成配对码”重新配对。',
    'pairing.revokedLabel': '配对已撤销。请重新将此设备与 Caxri 配对。',
    'pairing.revokedTitle': '配对已撤销',
    'pairing.scanAgain': '重新扫描',
    'pairing.scanAgainHint': '允许相机再次扫描配对码。',
    'pairing.scanCode': '扫描配对码',
    'pairing.scanDescription':
        '将相机对准电脑上 Caxri“设置 → 移动设备”中“生成配对码”显示的二维码。',
    'pairing.scanHint': '打开相机，扫描电脑上 Caxri 显示的配对码。',
    'pairing.storageError.description':
        '已保存的配对信息仍在这台手机上。请尝试重新读取；如果仍然失败，请在手机系统设置中清除 Caxri Mobile 的数据后重新配对。',
    'pairing.storageError.retryHint': '重新读取已保存的配对信息。',
    'pairing.storageError.title': '无法读取这台手机的配对信息',
};
