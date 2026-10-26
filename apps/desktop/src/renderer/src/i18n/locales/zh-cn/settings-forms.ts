import type { TranslatedNamespace } from '@caxri/protocol';

import type { settingsForms as source } from '../en/settings-forms';

export const settingsForms: TranslatedNamespace<typeof source> = {
    'settings.trustedDomainsForm.ariaLabel': '受信任域名编辑器',
    'settings.trustedDomainsForm.descriptionBeforeExample':
        '精确源只匹配一个协议和端口。使用显式的 ',
    'settings.trustedDomainsForm.descriptionAfterExample':
        ' 规则可同时信任该域名及其子域名。回环主机默认受信任。',
    'settings.trustedDomainsForm.inputLabel': '受信任域名规则',
    'settings.trustedDomainsForm.listLabel': '受信任域名规则列表',
    'settings.trustedDomainsForm.empty': '没有用户定义的受信任域名。',
    'settings.trustedDomainsForm.invalid': '请输入 HTTP(S) 源或显式的 https://*.example.com 规则。',
    'settings.trustedDomainsForm.duplicate': '该域名已受信任。',
    'settings.trustedDomainsForm.maximum': '受信任域名最多支持 {{maximum}} 条规则。',
    'settings.trustedDomainsForm.remove': '移除受信任域名 {{rule}}',
    'settings.trustedFoldersForm.ariaLabel': '受信任文件夹编辑器',
    'settings.trustedFoldersForm.description':
        '路径必须是绝对路径。受信任文件夹涵盖其下的所有内容。',
    'settings.trustedFoldersForm.inputLabel': '受信任文件夹规则',
    'settings.trustedFoldersForm.listLabel': '受信任文件夹规则列表',
    'settings.trustedFoldersForm.empty': '没有用户定义的受信任文件夹。',
    'settings.trustedFoldersForm.invalid': '请输入文件夹的绝对路径。',
    'settings.trustedFoldersForm.duplicate': '该文件夹已受信任。',
    'settings.trustedFoldersForm.maximum': '受信任文件夹最多支持 {{maximum}} 条规则。',
    'settings.trustedFoldersForm.remove': '移除受信任文件夹 {{rule}}',
    'settings.ignoredChecksForm.ariaLabel': '已忽略检查编辑器',
    'settings.ignoredChecksForm.description':
        '每个模式会与检查的作业名称、状态上下文和工作流名称进行匹配。匹配不区分大小写；* 和 ? 为通配符。',
    'settings.ignoredChecksForm.inputLabel': '已忽略检查规则',
    'settings.ignoredChecksForm.listLabel': '已忽略检查规则列表',
    'settings.ignoredChecksForm.empty': '没有已忽略的检查。',
    'settings.ignoredChecksForm.invalid': '请输入检查名称或 glob 模式。',
    'settings.ignoredChecksForm.duplicate': '该检查已被忽略。',
    'settings.ignoredChecksForm.maximum': '已忽略检查最多支持 {{maximum}} 条规则。',
    'settings.ignoredChecksForm.remove': '移除已忽略检查 {{rule}}',
    'settings.longRunningCommandsForm.ariaLabel': '长期运行的后台命令编辑器',
    'settings.longRunningCommandsForm.description':
        '按命令开头匹配；只写命令名时在任何目录都能匹配，用 &&、; 或 | 连接的每一段会分别检查。可用 * 作通配符，或写成 /regex/。',
    'settings.longRunningCommandsForm.inputLabel': '长期运行命令模式',
    'settings.longRunningCommandsForm.listLabel': '长期运行命令模式列表',
    'settings.longRunningCommandsForm.empty':
        '没有模式。所有后台命令都会让会话保持工作中，直到命令结束。',
    'settings.longRunningCommandsForm.invalid':
        '请输入命令（如 npm run dev）或有效的 /正则表达式/。',
    'settings.longRunningCommandsForm.duplicate': '该模式已在列表中。',
    'settings.longRunningCommandsForm.maximum': '最多只能添加 {{maximum}} 个模式。',
    'settings.longRunningCommandsForm.remove': '移除模式 {{rule}}',
    'settings.referenceLinksForm.ariaLabel': '终端引用链接编辑器',
    'settings.referenceLinksForm.descriptionBeforeToken':
        '匹配固定前缀，并将其标识符替换到 HTTP(S) URL 中的 ',
    'settings.referenceLinksForm.descriptionAfterToken': ' 处。规则只能打开链接，绝不会运行命令。',
    'settings.referenceLinksForm.listLabel': '终端引用链接规则',
    'settings.referenceLinksForm.externalReference': '外部引用',
    'settings.referenceLinksForm.edit': '编辑 {{prefix}} 引用',
    'settings.referenceLinksForm.delete': '删除 {{prefix}} 引用',
    'settings.referenceLinksForm.empty': '没有用户定义的终端引用链接。',
    'settings.referenceLinksForm.titleLabel': '引用标题',
    'settings.referenceLinksForm.titlePlaceholder': 'Linear Issue',
    'settings.referenceLinksForm.prefixLabel': '引用前缀',
    'settings.referenceLinksForm.urlLabel': '引用 URL 模板',
    'settings.referenceLinksForm.allowLetters': '标识符允许包含字母',
    'settings.referenceLinksForm.ignoreCase': '前缀忽略大小写',
    'settings.referenceLinksForm.invalidRule': '请输入有效的引用规则。',
    'settings.referenceLinksForm.overlap': '引用规则相互重叠。',
    'settings.excludeEditor.listLabel': '排除的文件模式',
    'settings.excludeEditor.toggle': '隐藏匹配 {{pattern}} 的文件',
    'settings.excludeEditor.removeTooltip': '移除模式',
    'settings.excludeEditor.remove': '移除排除模式 {{pattern}}',
    'settings.excludeEditor.newLabel': '新的排除模式',
    'settings.excludeEditor.add': '添加排除模式',
};
