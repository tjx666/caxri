import type { TranslatedNamespace } from '@caxri/protocol';

import type { gpu as source } from '../en/gpu';

export const gpu: TranslatedNamespace<typeof source> = {
    'gpu.turnOffConfirm.title': '关闭硬件加速并重启 Caxri？',
    'gpu.turnOffConfirm.message':
        'Caxri 将立即重启，并在此后每次启动时都使用软件渲染绘制。终端仍可正常使用，但绘制可能会变慢。你可以在设置中重新开启硬件加速。',
    'gpu.turnOffConfirm.confirmLabel': '关闭并重启',
    'gpu.restartFailed': '无法重启 Caxri',
    'gpu.notice.gpuProcessRecovery':
        '图形故障中断了绘制。受影响的终端已切换为软件渲染。可在状态栏中重试 GPU 渲染。',
    'gpu.notice.softwareRenderingPinned':
        '由于图形故障反复出现，Caxri 已切换为软件渲染，并将保持到下次重启。终端仍可正常使用，但绘制可能会变慢。你可以在设置中让每次启动都关闭硬件加速，或保持开启以便下次再尝试使用 GPU。',
    'gpu.notice.terminalFallback':
        '图形故障中断了一个终端的绘制。Caxri 已将其切换为软件渲染，终端仍可正常使用。',
};
