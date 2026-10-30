# Caxri

[English](README.md) | 简体中文

![Caxri 桌面端在三个项目中运行 Claude Code 与 Codex 会话，旁边是配对的 Caxri 移动端，列出需要关注的会话](docs/assets/readme-hero.png)

Caxri 是一款面向 macOS 的 Agent 开发环境（Agent Development Environment，ADE）：你通过已在使用的编码
Agent（Claude Code、Codex 和 Grok Build）构建软件的地方。它为这些 Agent 提供一致的工作流，把每个任务保存为本地项目文件夹下持久的会话，用自动化处理订阅的用量限制，并且只显示仍需要你处理的内容：哪个会话在等待你，以及它的
Agent 改了什么。Agent 变化很快，所以 Caxri 频繁发布，随之调整。

**支持：** Claude Code、Codex 和 Grok Build。Caxri 运行你自己安装的 Agent CLI，沿用它们已有的登录状态；它不捆绑任何 Agent 或订阅。界面提供英文和简体中文。

**Caxri 目前是预览版。** 它发布频繁，尚无兼容性承诺，因此某次更新可能需要重置本地数据，即
`~/Library/Application Support/Caxri` 中的配置档（见[卸载与重置](#卸载与重置)）。你的项目文件夹从不在重置范围内。源码公开和已发布的版本都不改变这一点；维护者会明确宣布任何兼容性承诺。

## 亮点

- **项目与会话。** 项目是你授权的一个文件夹。会话是其下持久的工作单元，各自拥有终端、布局和工作台状态。共享词汇见
  [GLOSSARY.md](GLOSSARY.md)。
- **跨 Agent 的统一工作流。** 无论由哪个 Agent 执行任务，会话、对话、关注提醒和用量的用法都相同。Claude Code 和 Codex
  优先支持；某个 Agent 缺少某项能力时，只是该 Agent 暂时没有这项功能。
- **对话优先，终端常在。** Agent 默认以可读的对话（Chat）打开，可以切换到真正的终端而不丢失对话。Shell
  始终在终端中运行。见 [docs/agent-chat.md](docs/agent-chat.md)。
- **让订阅为你工作。** 符合条件的空闲 Claude Code 和 Grok Build 对话会在提示缓存过期前被压缩；因用量耗尽而停止的对话会在重置时间已知且临近时自动恢复；套餐用完时，你可以换另一个
  Agent 继续这项工作。见 [docs/session-compaction.md](docs/session-compaction.md) 和
  [docs/agent-usage-continuation.md](docs/agent-usage-continuation.md)。
- **值得信赖的关注提醒。** 每个会话都会报告等待中、已完成或失败，即使同时运行一大批 Agent，也不会有谁悄无声息地卡住。
- **只显示你仍需要看的内容。** 精简的编辑器、文件树、搜索和以审阅为先的源代码管理视图，覆盖"看一眼 Agent 做了什么"的循环，而不变成 IDE。
- **为 Agent 驱动而设计。** `caxri` 命令及其内置 skill 让 Agent 驱动同一个应用 Server：创建会话、委派工作并汇报结果。Agent
  负责提交；你来合并拉取请求。见 [docs/cli.md](docs/cli.md)。

## Caxri 与其他工具的区别

- **直接在终端里运行 Claude Code 或 Codex。** Caxri 运行的是同样的 CLI，使用它们自己的登录状态，Agent
  本身没有任何变化。它在外围增加的是：每个任务是项目下持久的会话；Agent 以可读的对话打开，并可切换到它真正的终端；每个会话都报告等待中、已完成或失败；订阅自动化会压缩符合条件的空闲对话、在已知的用量重置后自动恢复，并提供换另一个
  Agent 继续的选项。
- **Conductor、Superset、Orca 等并行 Agent 工作台。** 它们并行运行多个 Agent CLI，每个任务放在独立的 Git
  worktree 中，并内置 diff 审阅；Conductor 还能跟踪检查状态，创建和合并拉取请求。Caxri 同样以同时监管多个 Agent
  为目标。它的侧重点是：Claude Code、Codex 和 Grok Build 之间统一的工作流；以对话为核心界面，终端始终可用；围绕套餐限额和提示缓存、开箱即用的自动化；以及只显示仍需要你处理的内容的界面。
- **Cursor 等 AI IDE。** Caxri 不是 IDE，也不是 VS Code 的分支，不会取代你的编辑器。它的编辑器、文件树、搜索和以审阅为先的源代码管理视图刻意保持精简，用于查看
  Agent 做了什么；它没有手动暂存或提交，因为提交由 Agent 完成，由你来合并拉取请求。

初次使用？阅读[入门指南](docs/getting-started.md)，五分钟了解基本模型。

## 系统要求

- 运行 macOS 13（Ventura）或更高版本的 Apple 芯片 Mac。
- 至少安装并登录一个受支持的 Agent CLI（Claude Code、Codex 或 Grok Build）。请先确认它能在终端中正常使用。Shell 会话不需要 Agent CLI。
- [Homebrew](https://brew.sh/)，仅用于安装可选的通知辅助程序。

发布版本仅支持 Apple 芯片。Intel Mac 可以从源码构建 Caxri（见
[CONTRIBUTING.md](CONTRIBUTING.md)）；目前不支持 Windows 和 Linux 桌面版本。

## 安装

把下面这段话粘贴给你的编码 Agent（Claude Code、Codex、Grok Build 或类似工具）：

```text
Install Caxri for me by following https://raw.githubusercontent.com/tjx666/caxri/main/docs/install.md
```

Agent 会检查你的 Mac，下载并校验最新版本，完成安装，并提供可选设置：通知横幅、`caxri`
命令，以及语言、默认 Agent、字号等初始设置。若要手动安装，请按同一页面操作：
[docs/install.md](docs/install.md)。

**Caxri 目前尚未经过 Apple 公证。** 如果 macOS 提示 Apple 无法验证 Caxri，打开**系统设置 → 隐私与安全性**点击**仍要打开**，或者运行一次下面的命令，然后重新打开：

```bash
xattr -dr com.apple.quarantine /Applications/Caxri.app
```

如果你是手动下载的磁盘映像，请先用对应的 `.sha256` 文件校验它。
[故障排查](docs/troubleshooting.md#macos-says-caxri-is-damaged-or-blocks-it)还说明了被 macOS 报告为"已损坏"的旧版本如何处理。

### 在 Android 上安装

Android 手机可以从同一个 [Release](https://github.com/tjx666/caxri/releases/latest) 安装配对的移动端：下载
`Caxri-Mobile-<version>-android-arm64.apk`，打开它，并在提示时允许浏览器或文件管理器安装应用。每个 APK 都附带
`.sha256` 校验文件；请使用与桌面端相同的版本。见[移动端安装与更新](docs/mobile/update.md#install-from-github-releases)。

## 第一个会话

把一个本地文件夹添加为项目，在其下创建会话，然后选择你已安装的 Agent 或 Shell。Agent 默认以对话打开；你可以随时把会话切换到它的终端。

Agent 默认拥有完全访问权限：它们无需询问即可编辑文件和运行命令。可以在**设置 → Agent**中修改。如有提示，请在 macOS
系统设置中允许辅助程序发送通知。

## 更新

Caxri 在启动时以及之后每隔几小时检查 GitHub 上的新版本。你也可以随时选择 **Caxri → 检查更新…**。新版本会在后台下载；准备就绪后，选择**重启以更新**，或者直接退出
Caxri，下次启动即为新版本。如果 Caxri 无法替换自身（例如它是从磁盘映像中运行的），对话框会说明如何手动安装已下载的磁盘映像。更新不会删除你的配置档或项目文件夹。见[桌面端更新](docs/desktop-updates.md)。面向贡献者的发布选项见
[RELEASING.md](RELEASING.md)。

## 面向应用用户的命令行

打开命令面板并运行**在 PATH 中安装 'caxri' 命令**，然后在新的终端中执行：

```bash
caxri --help
```

完整手册见 [docs/cli.md](docs/cli.md)。

## Caxri 会在你的 Mac 上改动什么

- **Agent hook 条目（默认关闭）。** 除非你开启生命周期 hook，否则 Caxri 不会改动你的 Agent 配置。对话从不需要它们。在终端中运行的
  Agent 用它们报告何时开始、等待或结束，使会话状态、未读标记和通知保持准确；Grok Build 必须开启它们才能在终端中运行。缺少 hook 的终端
  Agent 会提示你开启。开启后，Caxri 只会在 `~/.claude/settings.json`、`~/.codex/hooks.json` 或
  `~/.grok/hooks/caxri.json` 中添加带有自身标记的条目。在 Caxri 之外，这些条目会立即退出，并且只接收生命周期阶段，从不接收提示词或回复内容。可以在**设置
  → Agent**中按 Agent 关闭，这会移除 Caxri 的条目；你自己的 hook 保持不变。
- **用于 Claude 窗口的后台任务（Claude Pro）。** **保持 5 小时窗口滚动**（设置 → Agent → Claude）对 Claude Pro
  账户默认开启，对 Max 默认关闭。开启后，Caxri 会在 `~/Library/LaunchAgents` 下注册一个按用户运行的 launchd 任务（名称以
  `com.caxri.app.claude-windows` 开头；macOS 会把它列在登录项中），在窗口重置时向 Claude 发送一个最小请求。关闭该设置即可移除它。见
  [docs/claude-windows.md](docs/claude-windows.md)。
- **`caxri` 命令链接（仅在你安装后存在）。** 命令面板中的**在 PATH 中安装 'caxri' 命令**会创建符号链接
  `/usr/local/bin/caxri`。删除应用前请运行**从 PATH 中卸载 'caxri' 命令**，或之后用 `sudo rm /usr/local/bin/caxri`
  移除。
- **通知辅助程序。** `alerter` 由你通过 Homebrew 安装；Caxri 只负责运行它。
- **你的数据。** 配置档（数据库、设置）位于 `~/Library/Application Support/Caxri`，日志在其中的 `logs`
  文件夹。使用**帮助 → 在访达中显示日志**打开它们。
- **两类网络请求。** Caxri 会向 GitHub 的公开发布 API 查询新版本；在 Claude 窗口设置开启期间，还会向 Claude
  发送上文所述的那个最小请求。它没有遥测，诊断信息中也从不包含源代码内容、终端输出或 Agent 对话记录。你的 Agent CLI
  按各自的条款与各自的厂商通信。

## 卸载与重置

退出 Caxri，删除 `/Applications/Caxri.app`，再删除 `~/Library/Application Support/Caxri`
以清除其数据。在 Caxri 中删除项目或会话从不触碰你的文件夹或文件。删除之前，请在设置中关闭 Agent hook 和**保持 5 小时窗口滚动**（对
Claude Pro 默认开启），以便 Caxri 移除它的配置条目和后台任务。如果你安装了 `caxri` 命令，也请在命令面板中运行**从 PATH 中卸载
'caxri' 命令**（或之后执行 `sudo rm /usr/local/bin/caxri`）。在源码检出中，`bun run uninstall:caxri`
会预览一次完整的本地清理（hook 条目、后台任务、应用和配置档），并以归档代替删除；添加 `-- --yes` 即可执行。

## 支持与社区

- 遇到 bug、功能需求或疑问，请[提交 Issue](https://github.com/tjx666/caxri/issues/new/choose)。没有响应或解决时限（SLA）。也可以在应用中使用**帮助
  → 反馈问题**。
- 欢迎来自人和编码 Agent 的拉取请求；由维护者决定合并哪些。见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 请私下报告安全漏洞；见 [SECURITY.md](SECURITY.md)。
- 请求分流见 [SUPPORT.md](SUPPORT.md)，常见问题见 [docs/troubleshooting.md](docs/troubleshooting.md)。

## 许可证

Caxri 以 [Caxri Source-Available License 1.0](LICENSE) 源码可得（source-available）方式提供。它并非采用 OSI
批准的开源许可证。

将 Caxri 用于个人或公司工作、用它创作的产出（Outputs）赚钱、以及将私有的修改（Modifications）保持闭源，都是免费的。在遵守许可证的声明和源码可得条件下，允许免费再分发。销售、商业分发
Caxri 或其修改版，或对其访问收费，需要另行取得书面商业许可。商业条款请联系
[ytj2713151713@gmail.com](mailto:ytj2713151713@gmail.com)。

外部贡献在合并前需要接受 [Caxri 个人贡献者许可协议](CLA.md)。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。本译文仅供参考，许可证与贡献者许可协议以英文原文为准。

## 开发用量

维护者个人开发 Caxri 的 token 用量与等价 API 成本快照由脚本自动更新，只维护在英文 README 中，见
[Development usage](README.md#development-usage)。

## 文档

### 使用 Caxri

| 文档                                | 内容                           |
| ----------------------------------- | ------------------------------ |
| [入门指南](docs/getting-started.md) | 五分钟了解基本模型             |
| [故障排查](docs/troubleshooting.md) | 应用被拦截、通知、找不到 Agent |
| [docs/cli.md](docs/cli.md)          | `caxri` CLI 手册               |
| [GLOSSARY.md](GLOSSARY.md)          | 产品术语：项目、会话、关注提醒 |
| [SUPPORT.md](SUPPORT.md)            | 社区支持范围与请求分流         |
| [SECURITY.md](SECURITY.md)          | 私下报告漏洞的政策             |
| [LICENSE](LICENSE)                  | 源码可得的使用条款与商业许可   |

### 参与贡献

| 文档                                                                       | 内容                                   |
| -------------------------------------------------------------------------- | -------------------------------------- |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                         | Issue 与拉取请求的贡献流程             |
| [CLA.md](CLA.md)                                                           | 贡献者许可协议                         |
| [AGENTS.md](AGENTS.md)                                                     | 面向编码 Agent 的贡献者常规要求        |
| [DESIGN.md](DESIGN.md)                                                     | 权威的 UI 与交互规范                   |
| [docs/README.md](docs/README.md)                                           | 所有在用文档、ADR 与历史记录的完整索引 |
| [RELEASING.md](RELEASING.md)                                               | 未签名 DMG 的发布流程                  |
| [项目架构](.agents/skills/project-architecture/references/architecture.md) | 进程模型、恢复约定、依赖基线           |

## 产品边界

Caxri 把用户选择的文件夹视为项目，并在其下组织持久的会话。它原样运行你安装的 Agent CLI，要么通过厂商的结构化协议（对话，核心界面），要么在真正的
PTY 中运行（始终支持），并把登录交给 CLI 自己处理。源代码管理用于审阅 Agent 的工作：没有手动暂存或提交，因为提交由 Agent
完成。合并仍由人决定，所以 Caxri 提供拉取请求合并按钮。编辑器刻意保持精简，Caxri 不是 IDE，也不是 VS Code 的分支。这些边界背后的原则记录在
[ADR 0020](docs/adr/0020-agent-development-environment.md) 中。
