# 🔮 Antigravity Deck（中文增强版）

**专为 [Antigravity](https://antigravity.google) 打造的远程控制面板 —— 从任意设备管理 AI 对话、Cascade 任务与工作区。**

> 本仓库 Fork 自 [`tysonnbt/Antigravity-Deck`](https://github.com/tysonnbt/Antigravity-Deck)，在此基础上完成了**全界面简体中文本地化**，并新增了 **Antigravity CLI (`agy`) 版本检测与一键手动更新**能力，不锁定任何 `agy` 版本。

这是一个功能完整的 Antigravity Web 控制台，支持在电脑或手机上查看、发送与管理所有项目的 AI 对话，提供全局历史搜索、实时 Cascade 控制、资源监控、源码查看、IDE 扩展工具与安全远程访问。

> 基于 **Antigravity 2.0.11+** 单共享 **Hub** Language Server 架构构建。Deck 会自动发现运行中的 Hub、跟踪工作区，并通过 IDE 的 Jetbox 子系统流式获取完整对话历史。

---

## 🆕 本分支新增与增强

- **全量简体中文本地化**：完整汉化聊天对话界面、欢迎引导页、审批卡片、设置面板、资源监控、源码管理/Git 差异、实时日志、MCP / 工作流 / 长期记忆 / 仓库信息面板，以及安装/卸载脚本。
- **`agy` CLI 不锁版本 & 手动一键更新**：
  - 设置页新增 **「Antigravity CLI (`agy`) 版本与更新」** 卡片，自动探测本机 `agy` 可执行文件路径（支持在设置中自定义路径）。
  - 实时展示当前已安装的 `agy` 版本、直接拉取并浏览 `agy changelog` 官方更新日志。
  - 点击 **「更新到最新版」** 即可通过后端安全调用 `agy update` 升级到最新正式版本，即使 Language Server 尚未启动，也可从欢迎页直接进入设置完成更新。
  - 新增后端接口：`GET /api/agy/status`、`GET /api/agy/changelog`、`POST /api/agy/update`。

---

## 📸 界面截图

| 对话历史 | 对话详情 |
|:-:|:-:|
| ![History](docs/images/history-desktop.png) | ![Conversation](docs/images/conversation-desktop.png) |

| 资源监控 | 移动端适配 |
|:-:|:-:|
| ![Resources](docs/images/resource-monitor.png) | ![Mobile](docs/images/conversation-mobile.png) |

---

## ✨ 功能特性

### 🗂️ 对话历史与项目管理
- **全量历史记录**：通过 IDE 的 **Jetbox** 子系统（`JetboxSubscribeToSummaries`）流式加载所有项目的完整历史对话，而非仅限当前打开的几个窗口。
- **按项目分组**：历史记录页与侧边栏均支持按 Antigravity 项目分组展示与统计数量。
- **搜索与筛选**：按项目筛选或按标题搜索历史对话，展示所属项目、步骤数与更新时间。
- **新建与删除**：支持全局或按指定工作区发起新对话，随时删除旧对话。

### 💬 聊天与交互体验
- **实时收发**：直接在 Web 端发送消息，支持乐观渲染与流畅打字态展示。
- **完整步骤分页**：混合使用 JSON 与二进制 Protobuf 接口绕过约 600 步的 JSON 限制，向上滚动即可加载更早步骤。
- **WebSocket 实时同步**：自适应轮询 + 流式订阅 Language Server 状态（`StreamAgentStateUpdates` + Cascade SSE），即时感知等待用户输入等状态变化。
- **全步骤类型渲染**：支持用户输入、助手回复、工具调用、代码编辑、终端命令、浏览器子代理、生成图片等 20+ 种步骤。
- **多图上传**：支持文件选择、剪贴板粘贴（`Ctrl+V`）与拖拽上传。
- **模型选择器**：实时读取可用模型分组、配额进度条、图像支持标识与推荐标记。
- **高级渲染与效率工具**：Markdown 语法高亮、可折叠思考过程、`/` 工作流自动补全、步骤书签（`B`）、时间线定位、统计分析面板、Token 用量视图与 Markdown 导出（`Ctrl+Shift+E`）。

### 🖥️ 工作区与 Hub 管理
- **自动发现**：跨平台（Windows / macOS / Linux）自动探测正在运行的 Antigravity Hub Language Server 端口与 CSRF Token。
- **目录跟踪**：配置默认工作区根目录，自动列出子目录并通过 `AddTrackedWorkspace` 一键绑定。
- **启动 IDE**：未检测到运行中的 IDE 时，支持从 Web 端直接拉起 Antigravity，或先打开设置更新 `agy`。

### ⚡ Cascade 审批与控制
- **审批门控卡片**：当助手请求执行命令、编辑文件或 MCP 输入时，动态渲染与 IDE 一致的授权选项，支持远程批准或拒绝。
- **自动批准模式**：可选服务端自动放行待审批操作（含文件编辑的工作区边界校验，只读操作默认安全放行）。
- **随时中断**：支持立即取消正在运行的 Cascade 任务。

### 🧰 IDE 工具视图
- **MCP 服务器**：查看已配置的 MCP 服务器、工具清单与连接状态，支持在线启用/禁用。
- **工作流 / 技能 / 规则**：只读浏览全局与工作区下的 Workflows、Skills、Rules，支持将内置工作流复制到当前工作区编辑。
- **长期记忆**：查看助手沉淀的持久化 Knowledge Items。
- **仓库信息**：查看当前工作区 Git 分支状态与待处理的 AI 编辑。

### 📊 资源监控与实时日志
- **系统与进程监控**：每 5 秒采样系统 CPU、内存及各工作区/Deck 前后端进程资源占用，支持历史曲线与一键终止 IDE。
- **源码管理**：内置只读文件浏览器与 Git Diff 对比（`@git-diff-view` + 30+ 语言高亮），参数数组执行与路径安全校验。
- **实时日志**：WebSocket 实时查看后端探测、轮询与前端运行日志。

### 👤 多账号与安全远程访问
- **多账号切换** *(Windows)*：保存多套 Antigravity 凭据并在面板间一键切换。
- **API 密钥认证**：通过 `AUTH_KEY` 环境变量保护 HTTP API 与 WebSocket，支持登录弹窗及 `?key=` 自动登录。
- **Cloudflare 穿透**：`npm run online` 一键启动后端与前端隧道，并生成包含自动登录 URL 的二维码。
- **PWA 与 Web Push 推送**：支持桌面/手机安装为 PWA，并按事件类型（完成/等待确认/错误/自动批准）推送通知。

---

## 🚀 快速开始

### ⚡ 一键安装 / 更新（推荐）

无需手动配置 Git，直接执行一条命令即可安装、更新并启动服务（默认追踪本中文仓库 `main` 分支，可通过环境变量 `AG_DECK_REF` 指定版本）：

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/ooks37/Antigravity-Deck/main/scripts/setup.ps1 | iex
```

**macOS / Linux:**
```bash
curl -sL https://raw.githubusercontent.com/ooks37/Antigravity-Deck/main/scripts/setup.sh | bash
```

> **前置依赖：** [Node.js 18+](https://nodejs.org/)、[Git](https://git-scm.com/)；如需公网远程穿透还需安装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)。

### 🗑️ 一键卸载

自动停止相关进程并清理安装目录：

**Windows:**
```powershell
irm https://raw.githubusercontent.com/ooks37/Antigravity-Deck/main/scripts/uninstall.ps1 | iex
```

**macOS / Linux:**
```bash
curl -sL https://raw.githubusercontent.com/ooks37/Antigravity-Deck/main/scripts/uninstall.sh | bash
```

### 🛠️ 本地开发

```bash
# 安装前后端依赖并初始化 settings.json
npm run setup

# 同时启动后端 (:3500) 与前端热重载 (:3000)
npm run dev
```

浏览器打开 **http://localhost:3000** 即可访问。

### 🌐 公网远程访问 (Cloudflare Tunnel)

```bash
npm run online
```

自动生成认证密钥、构建前端并拉起双端穿透隧道，在终端打印可直接扫码免密登录的二维码。

### 🔑 本地开启认证保护

```bash
AUTH_KEY=your-secret-key npm run dev
```

---

## 📐 系统架构

```
┌────────────────────────┐  JSON + Binary Proto / streams  ┌───────────────┐
│   Antigravity Hub LS   │ ◄────────────────────────────── │   server.js   │
│  (单共享 Hub，自动探测)  │   Connect Protocol (HTTPS/HTTP) │   :3500 API   │
│                        │   Jetbox + AgentState streams   │   + WS hub    │
└────────────────────────┘                                 └──────┬────────┘
                                                                  │ WS (/ws) + HTTP
   ┌──────────────┐                                         ┌─────┴─────────┐
   │  Discord Bot │ ◄── /ws/agent + /api/agent (可选) ─────│   Next.js     │
   │  / 外部 AI    │                                         │   :3000 UI    │
   └──────────────┘                                         └───────────────┘
```

- **后端** (`server.js` + `src/`)：Express API 代理 + 3 个 WebSocket 服务（`/ws`、`/ws/agent`、`/ws/orchestrator`）、自适应轮询器、Jetbox/AgentState 流、`agy-manager.js` 版本升级管理、资源监控与多账号管理。
- **前端** (`frontend/`)：Next.js 16 (App Router) + React 19 + shadcn/ui + Tailwind CSS 4，提供完整桌面与移动端控制台体验。

---

## 📄 开源协议

MIT（上游原项目：[tysonnbt/Antigravity-Deck](https://github.com/tysonnbt/Antigravity-Deck)）
