# Open Code Review 桌面端配置器 — 设计文档

日期：2026-10-03
状态：已评审待实现计划

## 1. 背景与目标

[Open Code Review](https://github.com/alibaba/open-code-review)（简称 OCR）是一个开源的 AI 代码审查 CLI，命令名 `ocr`。它的所有配置目前都要靠命令行：

- LLM Provider / 模型：`ocr config set llm.url/auth_token/model/use_anthropic`
- 审查规则：手写 JSON 文件 `~/.opencodereview/rule.json`（全局）或 `<repo>/.opencodereview/rule.json`（仓库级）
- 审查参数：`ocr review` 的众多 flag（`--timeout` / `--concurrency` / `--format` / `--language` / `--exclude` 等）

**本项目目标**：为 OCR 提供一个桌面端原生窗口，把这些配置项做成可视化表单——降低使用门槛，避免记参数、手写 JSON 出错。

**目标用户**：已装或愿意装 `ocr`、但希望用 GUI 而非背命令行的开发者。

**成功标准**：

1. 应用能探测本机 `ocr` 是否安装，未安装给出引导。
2. 在 Provider Tab 配置 LLM 后，「测试连接」可调 `ocr llm test` 并展示结果。
3. 在 Rules Tab 可视化增删改 `rule.json`，并提供「验证文件命中规则」调 `ocr rules check`。
4. 在 Params Tab 配置审查默认参数，可持久化的落盘、不可持久化的给出命令片段预览。
5. 全程 Windows 原生窗口，包体可控（Tauri 特性）。

**非目标（明确不做）**：

- 不跑 `ocr review`、不展示审查结果、不管 `ocr session list` / `--resume` 历史。
- 不做规则语料的 AI 生成。
- 不做多 OCR 版本管理。

## 2. 技术栈与前置依赖

**技术栈（已与用户确认）**：

- 桌面壳：**Tauri 2.x**
- 前端：**React 18 + Vite + TypeScript**
- 后端命令层：**Rust**（Tauri commands）
- 配置读写策略：**全用 `ocr` CLI**（规则文件除外，见 §4.3 折中）

**前置依赖（实现前必须满足）**：

- Node.js v24（本机已有 v24.21.0）
- Rust 稳定工具链 + Windows MSVC 构建工具（`rustc` / `cargo`）——本机当前**缺失**，需先安装 [Rustup](https://rustup.rs) 与 Visual Studio Build Tools（含 MSVC）
- 全局安装 `ocr`：`npm i -g @alibaba-group/open-code-review`
- 操作系统：以 Windows 11 为主目标（用户环境）；Tauri 跨平台，后续可编译 macOS/Linux 但不在此版本范围

## 3. 架构

三层，前端不碰文件系统、不直接 spawn 进程：

```
┌──────────────────────────────────────────────┐
│  Tauri 窗口（原生桌面壳）                       │
│                                                │
│   ┌──────────────┐    Tauri IPC (invoke)       │
│   │ React 前端    │ ──────────────────────────┐│
│   │ Vite + TS     │                          ││
│   └──────────────┘                  ┌─────────▼─┐
│                                     │ Rust 后端   │
│                                     │ commands:   │
│                                     │ - spawn ocr │
│                                     │ - 解析输出  │
│                                     └────────┬───┘
│                                              │ child_process
│                                        ┌─────▼────┐
│                                        │ ocr CLI   │
│                                        │ (全局安装) │
│                                        └──────────┘
└──────────────────────────────────────────────┘
```

**职责边界**：

- 前端：渲染表单、维护表单状态、把「保存意图」打包成命令请求、展示命令返回结果。绝不 `fs` 读写、绝不 spawn。
- Rust 后端：唯一允许 spawn `ocr` 的层。负责命令拼装、Windows `.cmd` 解析、stdout/stderr 结构化、规则文件读写（§4.3）。
- `ocr` CLI：配置的真实存储与执行者。

**IPC 契约（Rust command → 前端返回）**：

所有 command 返回统一结构：

```ts
type OcrResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  // 解析后的结构化字段（如 provider 列表、连接结果），按需填充
  data?: unknown;
};
```

command 清单（初版）：

| command | 作用 | 调用 `ocr` |
|---|---|---|
| `probe_ocr` | 探测 `ocr --version`，返回是否安装及版本 | `ocr --version` |
| `get_provider_config` | 读取当前 LLM 配置 | `ocr config get`（逐键） |
| `set_provider_config` | 写入 Provider/模型/key | `ocr config set llm.*`（逐条） |
| `list_providers` | 列内置模型/provider 参考 | `ocr llm providers` |
| `test_connection` | 测试 LLM 连通性 | `ocr llm test` |
| `get_rules` | 读取 rule.json（全局或仓库级） | 直接读文件 |
| `set_rules` | 写入 rule.json | 直接写文件 |
| `check_rules` | 验证某文件命中的规则 | `ocr rules check <file>` |
| `get_params_config` | 读取审查参数默认值 | `ocr config get` 或文件 |
| `set_params_config` | 写入审查参数默认值 | `ocr config set`（可持久化键） |

## 4. 配置模型与命令映射

### 4.1 Provider / 模型

表单字段（随 provider 类型动态变化）：

- Provider 类型下拉：`Anthropic` / `OpenAI` / `AWS Bedrock` / `Custom`（自定义 OpenAI 兼容 URL）
- Anthropic：`Base URL`（`https://api.anthropic.com/v1/messages`）、`API Key`、`Model`
- OpenAI：`Base URL`、`API Key`、`Model`
- Bedrock：`Region`、`Access Key`、`Secret Key`、`Model`
- Custom：`Base URL`、`Auth Header 名`、`Auth Token`、`Model`

映射：

- `use_anthropic`（bool）→ 选 Anthropic 时为 `true`
- `url` → Base URL
- `auth_token` → API Key / Token（**永不回读明文**）
- `model` → Model 名

「内置模型」参考：调 `ocr llm providers` 拉取，展示为建议列表（非强制）。

### 4.2 审查参数（Params）

覆盖 `ocr review` 常用默认值：

| 参数 | flag | 持久化方式 |
|---|---|---|
| timeout | `--timeout` | 待 §8.2 确认是否 `config set` |
| concurrency | `--concurrency` | 同上 |
| format | `--format` | 同上 |
| language | `--language` | 同上 |
| exclude | `--exclude` | 同上 |

**可持久化的键**：经 `ocr config set` 写入。
**不可持久化的键**：在 Params Tab 以「命令片段预览（只读、可复制）」辅助，不执行、不写入——用户审查时自行拼进命令。

### 4.3 审查规则 rule.json（折中：直接读写文件）

**已与用户确认**：规则文件「直接读写文件、其余全走 CLI」。

理由：OCR 目前没有写入 `rule.json` 的 CLI 命令，`ocr rules check` 只做验证。规则文件是纯 JSON，结构稳定（`rules: [{path, rule, merge_system_rule}]`），直接读写安全且可离线。

- `get_rules(scope)`：`scope` ∈ {global, repo}；global 读 `~/.opencodereview/rule.json`，repo 读用户所选目录下的 `.opencodereview/rule.json`。文件不存在时返回空规则集。
- `set_rules(scope, repoPath?, rules)`：写回对应文件，写前做 JSON schema 校验（path 必填非空、rule 必填非空、merge_system_rule 为 bool）。
- `check_rules(file)`：调 `ocr rules check <file>`，展示命中规则。

## 5. UI / UX 设计

原生窗口，顶部状态条 + 三 Tab。

### 5.1 顶部状态条

- 左：`Open Code Review 配置器`
- 右：ocr 状态——检测到显示 `ocr ✓ vX.Y.Z`；未检测到显示 `ocr ✗ 未安装 [去安装]` 引导按钮

### 5.2 Provider Tab

```
Provider 类型: [ Anthropic ▾ ]
Base URL:     [ https://api.anthropic.com/v1/messages ]
API Key:      [ •••••••••• ] [显示/隐藏]
Model:        [ claude-opus-4-6 ▾ ]  （参考：内置模型列表）
[ 测试连接 ]  [ 保存 ]
连接结果: ✓ 200 OK / ✗ connection error: ...
```

- 切换 provider 类型 → 字段动态变。
- 「测试连接」→ `test_connection`。
- 「保存」→ 逐条 `set_provider_config`。
- API Key 始终掩码，保存后不回读明文（重开窗口显示空或占位）。

### 5.3 Rules Tab

```
作用范围: ( ) 全局 ~/.opencodereview  (•) 仓库级 [选择目录...]
┌───────────────────────────────────────────────┐
│ path (glob)        │ rule (文本)        │ merge │ ✎ │ 🗑 │
│ ───────────────────┼────────────────────┼──────┼───┼───│
│ **/*.java          │ 校验必填参数非空     │ [✓]  │ ✎ │ 🗑 │
│ **/*mapper*.xml     │ 检查 SQL 注入       │ [ ]  │ ✎ │ 🗑 │
└───────────────────────────────────────────────┘
[ + 新增规则 ]
验证命中: [ 选择文件 ] [ 用 ocr rules check 验证 ]  结果: ...
[ 保存规则文件 ]
```

- 作用范围切换：全局 vs 选仓库目录。
- 规则表格：行内编辑 path / rule / merge_system_rule 开关；增删。
- 「验证命中」：选一个源码文件 → `check_rules` → 展示该文件命中的规则。
- 「保存规则文件」：`set_rules` 写回。

### 5.4 Params Tab

```
Timeout (秒):     [ 15 ]
Concurrency:      [ 8 ]
Format:           [ text ▾ ] (text/json/sarif)
Language:         [ English ]
Exclude:          [ **/generated/*,**/testdata/* ]
[ 保存 ]
命令片段预览（复制即用）:
  ocr review --timeout 15 --concurrency 8 --format text --language English \
             --exclude "**/generated/*,**/testdata/*"
```

- 可持久化键落盘；不可持久化键只进预览框（§4.2 / §8.2 判定）。

## 6. 数据流

1. **加载**：窗口挂载 → `probe_ocr` → 已安装则并行 `get_provider_config` / `get_rules(global)` / `get_params_config` 填充表单。
2. **保存 Provider**：表单变更 → 「保存」→ `set_provider_config`（逐条 set）→ 返回每条成功/失败 → Toast 提示。
3. **测试连接**：`test_connection` → 解析 `ocr llm test` 输出 → 展示 ✓/✗ 与原因。
4. **保存规则**：编辑表格 → 「保存规则文件」→ `set_rules` 写文件（含 schema 校验）→ 失败则定位到具体规则行。
5. **验证命中**：选文件 → `check_rules` → 展示结果。

## 7. 边界与错误处理

- **未装 ocr**：启动即 `probe_ocr`；未检测到 → 顶部红条 + 引导 `npm i -g @alibaba-group/open-code-review`，配置功能禁用但不崩溃。
- **Windows `.cmd` 陷阱**：npm 全局装的 `ocr` 实为 `ocr.cmd` / `ocr.ps1`。Rust 中 `Command::new("ocr")` 在 Windows 找不到。后端解析 `npm bin -g` 或 `where ocr`，拼接 `.cmd`；实现时先用 `cmd /c ocr --version` 实测验证，选定最稳方案写进代码。
- **API Key 掩码**：auth_token 输入永不回显；保存后不回读明文。
- **命令失败解析**：捕获 stderr 关键词（`command not found` / `connection error` / `unknown flag`）翻译成中文提示。
- **规则 JSON 损坏**：`get_rules` 遇到非法 JSON → 提示「规则文件损坏，是否重置为空」而非崩溃。

## 8. 实现时第一步要做的探测（非 placeholder，是启动任务）

1. **Provider 字段集**：以 `ocr config provider` 交互流程 + `ocr llm providers` 输出反推各 provider 完整字段，补全 §4.1 表单。
2. **审查参数持久化**：跑 `ocr config set --help` 与 `ocr review --help` 枚举哪些参数可 `config set` 持久化；不可持久化的归入「命令预览」（§4.2 / §5.4）。
3. **rule.json 写命令**：确认 OCR 确实无 `ocr rules set/write` 类命令（已据 SKILL.md 判断无），坐实 §4.3 直接读写文件方案。
4. **Windows 二进制解析**：实测 `cmd /c ocr --version` 与 `where ocr` 行为，定 §7 的后端 spawn 方式。

## 9. 测试策略

- **Tauri 集成测试**：用 fake `ocr` 二进制（返回固定 stdout/stderr）替换真实 ocr，验证「前端 intent → Rust 命令拼装 → 输出解析」映射正确。覆盖：未安装、连接成功、连接失败、规则读写、规则校验失败。
- **前端单元测试**：Provider 表单字段联动（类型切换）、规则表格增删改纯函数、命令预览片段生成。
- **手动 E2E（本机）**：真装 ocr，走「配 Anthropic → 测试连接 ✓ → 加一条规则 → 验证命中 → 切仓库级读另一份 rule.json」。

## 10. 目录结构与文件清单（初版）

```
OpenCodeReviewClient/
├── package.json            # 前端依赖与脚本
├── vite.config.ts
├── tsconfig.json
├── index.html
├── src/
│   ├── main.tsx
│   ├── App.tsx             # 三 Tab 容器 + 顶部状态条
│   ├── ipc.ts              # Tauri invoke 封装 + OcrResult 类型
│   ├── tabs/
│   │   ├── ProviderTab.tsx
│   │   ├── RulesTab.tsx
│   │   └── ParamsTab.tsx
│   └── components/         # 规则表格、状态条、Toast 等
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   └── src/
│       ├── main.rs
│       ├── ocr.rs         # spawn ocr + 解析
│       └── commands.rs    # §3 的 command 实现
└── docs/superpowers/specs/ # 本设计文档
```

## 11. 实现顺序概要（详细计划由 writing-plans 产出）

1. 搭骨架：Rust 工具链安装 + `npm create tauri` 初始化 + 空三 Tab 窗口能跑起来。
2. `probe_ocr` + 顶部状态条 + 未安装引导。
3. Provider Tab：get/set/test_connection + 动态表单。
4. Rules Tab：get/set/check_rules + 规则表格 + 作用范围切换。
5. Params Tab：可持久化键 set + 命令预览。
6. 测试：集成测试 + 手动 E2E。
7. Windows 打包 `.msi` / `.exe`。
