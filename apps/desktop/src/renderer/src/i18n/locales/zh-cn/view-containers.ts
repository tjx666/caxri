import type { TranslatedNamespace } from '@caxri/protocol';

import type { viewContainers as source } from '../en/view-containers';
import { viewContainersFiles } from './view-containers-files';
import { viewContainersSourceControl } from './view-containers-source-control';

export const viewContainers: TranslatedNamespace<typeof source> = {
    'viewContainers.surface.loading': '正在加载视图…',
    'viewContainers.surface.loadFailed': '无法加载视图。',
    'viewContainers.surface.extensionUnavailable': '扩展不可用',
    'viewContainers.surface.retryExtensionFailed': '无法重试扩展',
    'viewContainers.extensionFailure.interrupted': '扩展连接已中断。请重试以重新连接。',
    'viewContainers.extensionFailure.timeout': '扩展未及时响应。请重试。',
    'viewContainers.extensionFailure.busy': '扩展正忙。请稍候再试。',
    'viewContainers.extensionFailure.denied': '扩展无权执行此操作或访问此项目。',
    'viewContainers.extensionFailure.tooLarge': '扩展返回的数据超出了此视图的显示上限。',
    'viewContainers.extensionFailure.generic': '扩展无法加载此视图。请重试，或检查扩展配置。',
    'viewContainers.extensionTree.refresh': '刷新 {{title}}',
    'viewContainers.extensionTree.noSession': '选择一个会话以加载此视图。',
    'viewContainers.extensionTree.loading': '正在加载视图…',
    'viewContainers.extensionTree.loadFailed': '无法加载视图：{{message}}',
    'viewContainers.extensionTree.empty': '此视图中没有内容。',
    'viewContainers.extensionTree.collapseItem': '折叠 {{label}}',
    'viewContainers.extensionTree.expandItem': '展开 {{label}}',
    'viewContainers.extensionTree.actionsHint':
        '操作：{{names}}。按右方向键可到达这些操作，或按 Shift+F10 打开菜单。',
    'viewContainers.extensionTree.actionsHintCollapsed':
        '操作：{{names}}。按右方向键展开此行，再按一次右方向键可到达这些操作，或按 Shift+F10 打开菜单。',
    'viewContainers.extensionTree.openTooltipLink': '打开 {{label}}：{{value}}',
    'viewContainers.extensionTree.stateSaveFailed': '无法保存扩展树状态',
    'viewContainers.commands.runFailed': '无法运行“{{title}}”',
    'viewContainers.commands.linkMissing': '无法运行“{{title}}”。缺少链接。',
    'viewContainers.commands.promptMissing': '{{failure}}。缺少提示词。',
    'viewContainers.commands.sentToAgent': '已发送给 {{agent}}',
    'viewContainers.commands.loadFailed': '无法加载扩展命令',
    'viewContainers.commands.unknown': '未知命令：{{commandId}}',
    'viewContainers.builtin.files': '文件',
    'viewContainers.builtin.info': '信息',
    'viewContainers.builtin.logs': '日志',
    ...viewContainersFiles,
    ...viewContainersSourceControl,
};
