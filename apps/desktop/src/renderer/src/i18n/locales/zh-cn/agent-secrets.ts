import type { TranslatedNamespace } from '@caxri/protocol';

import type { agentSecrets as source } from '../en/agent-secrets';

export const agentSecrets: TranslatedNamespace<typeof source> = {
    'agentSecrets.request.title': '{{agent}} 需要一个密钥',
    'agentSecrets.request.agentFallback': 'Agent',
    'agentSecrets.request.reasonLabel': 'Agent 给出的原因',
    'agentSecrets.request.valueLabel': '{{name}} 的值',
    'agentSecrets.request.allProjects': '用于所有项目',
    'agentSecrets.request.privacy': '保存在这台 Mac 上，供 Agent 在命令中使用，不会加入对话。',
    'agentSecrets.request.save': '保存',
    'agentSecrets.request.decline': '拒绝',
    'agentSecrets.request.openSession': '打开会话',
    'agentSecrets.request.more': '还有 {{count}} 个在等待',
    'agentSecrets.request.failed': '无法回复这个请求，请重试。',
    'agentSecrets.request.gone': 'Agent 已不再等待这个密钥。',
    'agentSecrets.settings.empty':
        '还没有密钥。Agent 需要时，Caxri 会在这里向你索取，而不是在对话里。',
    'agentSecrets.settings.loading': '正在加载密钥…',
    'agentSecrets.settings.loadFailed': '无法加载已保存的密钥。',
    'agentSecrets.settings.add': '添加密钥',
    'agentSecrets.settings.name': '名称',
    'agentSecrets.settings.namePlaceholder': 'API_TOKEN',
    'agentSecrets.settings.value': '值',
    'agentSecrets.settings.scope': '可用范围',
    'agentSecrets.settings.scopeGlobal': '所有项目',
    'agentSecrets.settings.save': '保存',
    'agentSecrets.settings.cancel': '取消',
    'agentSecrets.settings.replace': '替换值',
    'agentSecrets.settings.delete': '删除 {{name}}',
    'agentSecrets.settings.deleteTitle': '删除 {{name}}？',
    'agentSecrets.settings.deleteMessage': 'Agent 将无法再在{{scope}}中使用它。此操作无法撤销。',
    'agentSecrets.settings.deleteConfirm': '删除',
    'agentSecrets.settings.saveFailed': '无法保存密钥。',
    'agentSecrets.settings.invalidName':
        '只能使用字母、数字和下划线，并以字母或下划线开头。CAXRI_ 开头的名称为保留名称。',
    'agentSecrets.settings.updated': '更新于 {{time}}',
    'agentSecrets.settings.missingProject': '已移除的项目',
};
