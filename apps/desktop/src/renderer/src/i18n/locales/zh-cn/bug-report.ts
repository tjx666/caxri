import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { bugReport as source } from '../en/bug-report';

export const bugReport: TranslatedNamespace<typeof source> = {
    // Dialog
    'bugReport.dialog.title': '向 Agent 报告 Bug',
    'bugReport.dialog.description':
        '截图、标注，并将已脱敏的 Markdown Bug 报告发送给当前会话中正在运行的 Agent。',
    'bugReport.dialog.restoredDraft':
        '已恢复你未发送的草稿，包括截图及其标注。如需重新开始，请使用下方的“丢弃草稿”。',

    // Form
    'bugReport.form.noRunningAgent': '此会话中没有正在运行的 Agent，你仍可复制报告并手动粘贴。',
    'bugReport.form.actualLabel': '实际行为',
    'bugReport.form.actualPlaceholder': '发生了什么？',
    'bugReport.form.expectedLabel': '预期行为',
    'bugReport.form.expectedPlaceholder': '本应发生什么？',
    'bugReport.form.stepsLabel': '复现步骤（可选）',
    'bugReport.form.discardDraft': '丢弃草稿',
    'bugReport.form.preparing': '正在准备…',
    'bugReport.form.previewReport': '预览报告',

    // Screenshot field
    'bugReport.screenshot.title': '截图',
    'bugReport.screenshot.alt': '当前 Caxri 窗口的未脱敏截图，包含所有打开的文件和终端输出',
    'bugReport.screenshot.annotateCaptured': '标注已捕获的截图',
    'bugReport.screenshot.annotationCountOne': '1 处标注',
    'bugReport.screenshot.annotationCountOther': '{{count}} 处标注',
    'bugReport.screenshot.annotate': '标注',
    'bugReport.screenshot.capturing': '正在截图…',
    'bugReport.screenshot.retake': '重新截图',
    'bugReport.screenshot.unredactedWarning':
        '与文字报告不同，此截图未经脱敏：它会显示屏幕上的所有内容，包括源代码和终端输出。',
    'bugReport.screenshot.retryCapture': '重试截图',
    'bugReport.screenshot.capture': '截图',
    'bugReport.screenshot.textOnly': '报告将仅以文字形式发送。',

    // Image delivery notice
    'bugReport.imageDelivery.savedPath':
        '截图会保存到临时文件，其路径会包含在报告中，以便 Agent 打开。',
    'bugReport.imageDelivery.pasted':
        '截图会保存到临时文件，其路径会包含在报告中，以便 Agent 打开。截图还会直接粘贴给此 Agent；发送时系统剪贴板的内容会被替换为该图片。',

    // Preview
    'bugReport.preview.unredactedNotice':
        '此截图未经脱敏：它会捕获 Caxri 窗口中当前可见的所有内容，包括打开的文件和终端输出。',
    'bugReport.preview.targetAgent': '目标 Agent',
    'bugReport.preview.noRunningAgent': '此会话中没有正在运行的 Agent',
    'bugReport.preview.sessionChanged': '所选会话已变更。请复制报告或重新打开此流程。',
    'bugReport.preview.noAgentAvailable': '没有可用的运行中 Agent。你仍可复制报告。',
    'bugReport.preview.copyReport': '复制报告',
    'bugReport.preview.sending': '正在发送…',
    'bugReport.preview.sendToAgent': '发送给 Agent',

    // Dialog flow messages
    'bugReport.flow.selectSession': '请先选择一个会话，再向 Agent 报告 Bug。',
    'bugReport.flow.contextLoadFailed': '无法加载 Caxri 上下文。',
    'bugReport.flow.captureFailed': '无法截取 Caxri 窗口。',
    'bugReport.flow.discardConfirmTitle': '丢弃此 Bug 报告草稿？',
    'bugReport.flow.discardConfirmMessage':
        '你填写的文字、截图及其上的所有标注都将被删除。此操作无法撤销。',
    'bugReport.flow.keepDraft': '保留草稿',
    'bugReport.flow.saveScreenshotFailed': '无法保存截图文件。报告中将不包含图片路径。',
    'bugReport.flow.copied': '已复制 Bug 报告',
    'bugReport.flow.copyFailed': '无法复制 Bug 报告。',
    'bugReport.flow.agentStopped': '所选 Agent 已不再运行。请选择其他 Agent 或复制报告。',
    'bugReport.flow.sent': '已将 Bug 报告发送给 {{title}}',
    'bugReport.flow.sendFailed': '无法发送 Bug 报告。',

    // Annotator dialog
    'bugReport.annotator.title': '标注截图',
    'bugReport.annotator.description': '标出有问题的区域，并为每处标记写一条备注。',
    'bugReport.annotator.tool': '标注工具',
    'bugReport.annotator.box': '矩形框',
    'bugReport.annotator.arrow': '箭头',
    'bugReport.annotator.limit': '最多 {{max}} 处标注',
    'bugReport.annotator.hint': '在截图上拖动以标记区域，或在截图上按 Enter',
    'bugReport.annotator.rendering': '正在渲染…',
    'bugReport.annotator.renderFailed': '无法渲染标注后的截图。',
    'bugReport.annotator.readFailed': '无法读取已捕获的截图。',
    'bugReport.annotator.canvasFailed': '无法为标注后的截图准备画布。',
    'bugReport.annotator.encodeFailed': '无法将标注后的截图编码为 JPEG。',

    // Annotation list and canvas
    'bugReport.annotations.title': '标注',
    'bugReport.annotations.description': '描述每个标记区域中的问题。',
    'bugReport.annotations.empty': '尚无标记。在截图上拖动以添加，或在截图上按 Enter。',
    'bugReport.annotations.noteLabel': '标注 {{number}} 的备注',
    'bugReport.annotations.notePlaceholder': '这里有什么问题？',
    'bugReport.annotations.delete': '删除标注 {{number}}',
    'bugReport.annotations.select': '选择标注 {{number}}',
    'bugReport.annotations.canvas': '截图标注画布',

    // Screen reader announcements for the keyboard annotation path
    'bugReport.keyboard.arrowSegment': '箭头，从 {{from}} 到 {{to}}',
    'bugReport.keyboard.boxSegment': '矩形框，{{width}} × {{height}} 像素，位于 {{point}}',
    'bugReport.keyboard.marksOne': '1 处标记',
    'bugReport.keyboard.marksOther': '{{count}} 处标记',
    'bugReport.keyboard.boxDescription':
        '矩形框工具，{{marks}}。按 Enter 在键盘光标处开始绘制矩形框，按方向键调整大小，按 Option 加方向键移动，再按 Enter 添加，按 Escape 丢弃。按住 Shift 可移动得更远。按 Delete 删除所选标记。',
    'bugReport.keyboard.arrowDescription':
        '箭头工具，{{marks}}。按 Enter 在键盘光标处开始绘制箭头，按方向键调整大小，按 Option 加方向键移动，再按 Enter 添加，按 Escape 丢弃。按住 Shift 可移动得更远。按 Delete 删除所选标记。',
    'bugReport.keyboard.cursorAt': '光标位于 {{point}}。',
    'bugReport.keyboard.segment': '{{description}}。',
    'bugReport.keyboard.boxStarted': '已在 {{point}} 开始绘制矩形框。',
    'bugReport.keyboard.arrowStarted': '已在 {{point}} 开始绘制箭头。',
    'bugReport.keyboard.boxLimit': '最多 {{max}} 处标记。请先删除一处，再添加矩形框。',
    'bugReport.keyboard.arrowLimit': '最多 {{max}} 处标记。请先删除一处，再添加箭头。',
    'bugReport.keyboard.boxTooSmall': '此矩形框太小，无法添加。请按方向键将其放大。',
    'bugReport.keyboard.arrowTooSmall': '此箭头太短，无法添加。请按方向键将其拉长。',
    'bugReport.keyboard.added': '已添加{{description}}。',
    'bugReport.keyboard.boxDiscarded': '已丢弃矩形框。',
    'bugReport.keyboard.arrowDiscarded': '已丢弃箭头。',
    'bugReport.keyboard.cursorHidden': '已隐藏键盘光标。',
    'bugReport.keyboard.deletedSelected': '已删除所选标记。',
};
