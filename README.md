# Open Code Review 配置器

为 [Open Code Review](https://github.com/alibaba/open-code-review)（`ocr` CLI）提供桌面端可视化配置的 Tauri 应用。

不用记命令行参数、不用手写 JSON：在图形界面里配置 LLM Provider 与模型、编辑审查规则、设置审查参数，并能一键测试连通性、验证规则命中。

## 功能

| 模块 | 能做什么 |
|---|---|
| **Provider** | 选择内置 provider（30+，来自 `ocr llm providers`）或自定义 OpenAI 兼容网关；填写 API Key / Model / Max Tokens / Effort；「测试连接」调 `ocr llm test` 验证 |
| **Rules** | 编辑全局（`~/.opencodereview/rule.json`）或仓库级（`<repo>/.opencodereview/rule.json`）审查规则；表格增删改（path glob / 规则文本 / merge_system_rule 开关）；「验证命中」调 `ocr rules check` 查看某文件命中的规则 |
| **Params** | 持久化 `max_tokens` / `effort`（写入 `config.json`）；为不可持久化的 `timeout` / `concurrency` / `format` / `exclude` 生成可复制的 `ocr review` 命令片段 |

界面遵循 **mimo-design** 设计语言：纸感浅色底（`#FCFAF8`）、墨黑主操作、鼠尾草绿点缀，Georgia 衬线标题；同时支持暗色模式（跟随系统）。

## 前置依赖

- **[Open Code Review CLI](https://github.com/alibaba/open-code-review)**：`npm i -g @alibaba-group/open-code-review`
  - 应用通过 `ocr.cmd` 调用它（Windows 下 npm 全局安装的形态）。若未安装，应用顶部状态条会显示「未安装」并给出安装引导。
- **运行环境**：Windows 11（主目标）；Tauri 跨平台，macOS / Linux 未在本项目验证。
- **WebView2 运行时**：Windows 11 通常自带。

## 使用

### 安装（推荐）

从 [Releases](https://github.com/ZJFERAL/OpenCodeReviewClient/releases) 下载安装包：

- `OCR Desktop Config_<version>_x64-setup.exe`（NSIS，**免管理员权限**，装到用户目录）
- `OCR Desktop Config_<version>_x64_zh-CN.msi`（MSI）

安装后从开始菜单启动。顶部状态条会显示 `ocr ✓ vX.Y.Z`；未安装 ocr 时显示红色引导。

### 从源码运行

```bash
# 1. 安装前端依赖
npm install

# 2. 开发模式（热重载）
npm run tauri dev

# 3. 构建安装包（产物在 src-tauri/target/release/bundle/）
npm run tauri build
```

需要 Rust 工具链（本机为 `stable-x86_64-pc-windows-msvc`）与 Node.js 18+。

## 开发

### 常用命令

```bash
npm run dev        # 仅前端（Vite dev server，无 Tauri 后端；IPC 会失败）
npm run build      # 前端类型检查 + 构建（tsc --noEmit && vite build）
npm test           # 前端单元测试（Vitest）
npm run tauri dev  # 完整桌面应用（开发）
npm run tauri build

# Rust 测试（必须在 src-tauri 目录，且带 --no-default-features，见下）
cd src-tauri && cargo test --no-default-features
```

> **为什么 Rust 测试要 `--no-default-features`**：`tauri` 与 `tauri-plugin-dialog` 是 optional feature，默认开启（真实 app 需要）。测试时关掉它们，测试二进制就不链接 GUI 运行时，编译更干净、跑得更快。核心逻辑（`ocr.rs`）在两种 feature 组合下都会编译，因此测试覆盖不受影响。

### 架构

三层，前端不碰文件系统、不直接 spawn 进程：

```
┌──────────────────────────────────────────────┐
│  Tauri 窗口                                    │
│   ┌──────────────┐    Tauri IPC (invoke)       │
│   │ React 前端    │ ──────────────────────────┐│
│   │ Vite + TS     │                          ││
│   └──────────────┘                  ┌─────────▼─┐
│                                     │ Rust 后端   │
│                                     │ commands:   │
│                                     │ - spawn ocr │
│                                     │ - 读 config │
│                                     │ - 读写 rule │
│                                     └────────┬───┘
│                                              │
│                                        ┌─────▼────┐
│                                        │ ocr.cmd   │
│                                        └──────────┘
```

- **前端**（`src/`）：渲染与表单状态，经 `src/ipc.ts` 的封装调用后端。绝不 `fs` / spawn。
- **Rust 后端**（`src-tauri/src/`）：唯一允许 spawn `ocr` 与读写配置文件的层。
  - `ocr.rs`：核心逻辑——`run_ocr`（直接 spawn `ocr.cmd`）、读 `config.json`、读写 `rule.json`、各 `set_*` 命令、版本/表格解析。
  - `commands.rs`：`#[tauri::command]` 薄壳，转调 `ocr.rs`。
  - `lib.rs`：注册 command handlers。

### 配置文件位置

| 文件 | 路径 | 读写方式 |
|---|---|---|
| LLM 配置 | `~/.opencodereview/config.json` | 读：直接解析 JSON；写：`ocr config set` |
| 全局规则 | `~/.opencodereview/rule.json` | 直接读写文件（ocr 无写规则命令） |
| 仓库级规则 | `<repo>/.opencodereview/rule.json` | 同上 |

Windows 上 `~` 即 `%USERPROFILE%`（`dirs::home_dir()`），与 ocr CLI 的解析一致。

### 可持久化的配置键

只有这些键能被 `ocr config set` 持久化（已实测确认）：

- `provider`、`model`
- `max_tokens`、`effort`
- `providers.<name>.api_key`
- `custom_providers.<name>.{url,protocol}`

`timeout` / `concurrency` / `format` / `exclude` 只是 `ocr review` 的运行时 flag，**不能**持久化——Params 页只把它们拼成命令片段供复制。

### IPC 命令清单

| Command | 作用 |
|---|---|
| `probe_ocr` | 探测 ocr 是否安装并取版本 |
| `run_ocr` | 透传参数执行 ocr（预留） |
| `get_config` | 读 `config.json` |
| `set_provider` / `set_provider_key` / `set_custom_provider` / `set_model` / `set_param` | 写配置 |
| `test_connection` | `ocr llm test` |
| `list_providers` | `ocr llm providers` |
| `get_rules` / `set_rules` / `check_rules` | 规则读写与命中验证 |

## 设计文档

- 设计 spec：`docs/superpowers/specs/2026-10-03-opencode-review-desktop-config-design.md`
- 实现计划：`docs/superpowers/plans/2026-10-03-opencode-review-desktop-config.md`

## 已知限制

- 未在 macOS / Linux 上验证（主目标为 Windows 11）。
- 安装后的 GUI 端到端走查通过 WebView2 调试端口读 DOM 完成，未做完整人工点击回归。
- `ocr` 的 CLI 输出文案若变更，`translateError` 的关键词映射需同步更新。

## 许可

见仓库 LICENSE（如有）。本应用为 Open Code Review 的第三方桌面封装，非官方项目。
