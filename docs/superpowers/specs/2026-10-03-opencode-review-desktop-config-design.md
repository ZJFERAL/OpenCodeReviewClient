# Open Code Review 桌面端配置器 — 设计文档

日期：2026-10-03
状态：已评审，已据实测 ocr v1.12.11 修正配置语法，待实现计划

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
- Rust 工具链：**本机用 GNU target + LLVM-MinGW**（详见下），非 MSVC。
- 全局安装 `ocr`：本机已装 `open-code-review v1.12.11`（路径 `/d/nodejs/node_global/ocr`）。新机器需 `npm i -g @alibaba-group/open-code-review`
- 操作系统：以 Windows 11 为主目标（用户环境）；Tauri 跨平台，后续可编译 macOS/Linux 但不在此版本范围

**工具链方案（实现期实测确定，见 §12）**：本机 MSVC 因 UAC 无法在无人值守环境安装，改用 **GNU target + LLVM-MinGW**：
- `llvm-mingw-20260922-ucrt-x86_64`（clang 23 + lld）解压于 `C:/Users/Jeffery/llvm-mingw/`
- 编译命令：`cargo +nightly-x86_64-pc-windows-gnu build`（gnu host 使 embed-resource 走 windres 生成 GNU 资源；stable/msvc-host 产出的 PE 在 Win11 崩 `0xc0000139`）
- 测试命令：`cargo +nightly-x86_64-pc-windows-gnu test --no-default-features`（带 tauri 的测试二进制在本机仍崩）
- 配置固化于 `.cargo/config.toml`；详见 §12。

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

| command | 作用 | 调用 `ocr` / 文件 |
|---|---|---|
| `probe_ocr` | 探测 `ocr --version`，返回是否安装及版本 | `ocr --version`（经 `cmd /c`） |
| `get_config` | 读取当前 `~/.opencodereview/config.json` | **直接读 JSON 文件**（无 `ocr config get`） |
| `set_provider` | 写 provider 选择 | `ocr config set provider <name>` |
| `set_provider_key` | 写某 provider 的 api_key | `ocr config set providers.<name>.api_key <val>` |
| `set_custom_provider` | 写自定义 gateway (url/protocol) | `ocr config set custom_providers.<name>.{url,protocol}` |
| `set_model` | 写默认 model | `ocr config set model <name>` |
| `set_param` | 写可持久化审查参数 | `ocr config set <key> <val>`（仅 `max_tokens`/`effort` 等可持久化键） |
| `list_providers` | 列内置 provider 参考 | `ocr llm providers` |
| `test_connection` | 测试 LLM 连通性 | `ocr llm test` |
| `get_rules` | 读取 rule.json（全局或仓库级） | 直接读文件 |
| `set_rules` | 写入 rule.json | 直接写文件 |
| `check_rules` | 验证某文件命中的规则 | `ocr rules check <file>` |

**关键事实（实测 ocr v1.12.11）**：
- `ocr config` **没有 `get` 子命令**，只有 `set` / `unset` / `provider` / `model`。读配置只能直接解析 `~/.opencodereview/config.json`。
- `ocr config set` 实际可持久化的键（由 `unset` 支持集反推）：`provider` / `model` / `max_tokens` / `effort` / `providers.<name>.api_key` / `custom_providers.<name>.{url,protocol}` / `mcp_servers.<name>`。`--timeout`/`--concurrency`/`--format` 仅是 `ocr review` 运行时 flag，**不能 config set 持久化**。
- Windows 二进制：`ocr`、`ocr.cmd`、`ocr.ps1` 共存；Rust 后端统一用 `cmd /c ocr <args>` 执行，避免 `.cmd` 解析陷阱。

## 4. 配置模型与命令映射

### 4.1 Provider / 模型

**实测配置语法（v1.12.11）**：选择 provider 用 `ocr config set provider <name>`；各 provider 的 key 用 `ocr config set providers.<name>.api_key <val>`；自定义 gateway 用 `ocr config set custom_providers.<name>.{url,protocol}`；默认模型用 `ocr config set model <name>`。后端写配置**只用这些 set 命令**；读配置**直接解析 `config.json`**（无 get 命令）。

表单字段（随 provider 类型动态变化）：

- Provider 类型下拉：从 `ocr llm providers` 的内置列表 + `Custom` 中选择（内置含 anthropic / openai / bedrock / deepseek / kimi / qwen 系列等 30+ 项）
- 内置 provider（anthropic/openai/bedrock/...）：`API Key`、`Model`（model 仅作默认覆盖，可为空用 provider 默认）
- Custom（自定义 OpenAI 兼容网关）：`Gateway 名称`、`URL`、`Protocol`（openai / anthropic / openai-responses）、`API Key`、`Model`

映射：

- provider 类型 → `ocr config set provider <name>`（`custom_providers.<name>` 时设为该网关名）
- api_key → `ocr config set providers.<name>.api_key <val>`（**永不回读明文**，config.json 里也可能存明文，UI 一律掩码）
- custom url/protocol → `ocr config set custom_providers.<name>.{url,protocol}`
- model → `ocr config set model <name>`（可选）

「内置模型」参考：`ocr llm providers` 拉取 provider 列表展示为选择参考（非强制）；具体 model 名由用户填写或填 provider 默认。

### 4.2 审查参数（Params）

**实测**：`ocr review --help` 暴露 `--timeout` / `--concurrency` / `--format` / `--exclude` / `--max-tokens` / `--effort` 等运行时 flag；但能 **config set 持久化**的只有 `max_tokens` 与 `effort`（由 `unset` 支持集确认）。`--timeout`/`--concurrency`/`--format`/`--exclude` 仅运行时 flag，无法持久化。

| 参数 | 可持久化 | 处理方式 |
|---|---|---|
| max_tokens | ✅ | `ocr config set max_tokens <n>` |
| effort | ✅ | `ocr config set effort <low\|medium\|high>` |
| timeout | ❌ 仅 flag | Params Tab 命令预览（复制即用） |
| concurrency | ❌ 仅 flag | 同上 |
| format | ❌ 仅 flag | 同上 |
| exclude | ❌ 仅 flag | 同上 |

**可持久化的键**：经 `ocr config set` 写入。
**不可持久化的键**：在 Params Tab 以「命令片段预览（只读、可复制）」辅助，不执行、不写入——用户审查时自行拼进命令。

> 注：spec 早期版本误写了 `--language` 与 `llm.url/auth_token` 等；实测 v1.12.11 中 `review` 无 `--language` flag、`config` 无 `llm.*` 键，已按真实 CLI 修正如上。

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

1. **加载**：窗口挂载 → `probe_ocr` → 已安装则并行 `get_config` / `get_rules(global)` 填充表单。
2. **保存 Provider**：表单变更 → 「保存」→ 逐条 `set_provider` / `set_provider_key` / `set_custom_provider` / `set_model` → 返回每条成功/失败 → Toast 提示。
3. **测试连接**：`test_connection` → 解析 `ocr llm test` 输出 → 展示 ✓/✗ 与原因。
4. **保存规则**：编辑表格 → 「保存规则文件」→ `set_rules` 写文件（含 schema 校验）→ 失败则定位到具体规则行。
5. **验证命中**：选文件 → `check_rules` → 展示结果。
6. **保存参数**：Params Tab → `set_param` 写 `max_tokens`/`effort`；不可持久化项仅生成命令预览。

## 7. 边界与错误处理

- **未装 ocr**：启动即 `probe_ocr`；未检测到 → 顶部红条 + 引导 `npm i -g @alibaba-group/open-code-review`，配置功能禁用但不崩溃。
- **Windows 执行方式（已确认）**：后端统一 `cmd /c ocr <args>` 执行，绕开 `.cmd` 解析陷阱（见 §8.4）。
- **API Key 掩码**：config.json 中 key 可能明文存储，UI 一律掩码不回显；保存后重开窗口显示空占位。
- **命令失败解析**：捕获 stderr 关键词（`command not found` / `connection error` / `unknown flag`）翻译成中文提示。
- **安全纪律**：任何 `ocr config set/unset` 仅在用户显式点击「保存」时执行；实现/测试阶段不得为探测而写配置。临时改动须立即还原。
- **规则 JSON 损坏**：`get_rules` 遇到非法 JSON → 提示「规则文件损坏，是否重置为空」而非崩溃。

## 8. 实现前已完成的探测结论（实测 ocr v1.12.11，非 placeholder）

1. **Provider 字段集（已确认）**：`ocr llm providers` 输出 30+ 内置 provider（anthropic / openai / bedrock / deepseek / kimi / qwen 系列等），每个含 `NAME / PROTOCOL / BASE URL`。表单据此渲染 provider 下拉 + 自定义 gateway 分支。具体 api_key / model 字段见 §4.1。
2. **审查参数持久化（已确认）**：可 `config set` 持久化的仅 `max_tokens`、`effort`；`timeout`/`concurrency`/`format`/`exclude` 仅 `ocr review` 运行时 flag，不可持久化，归入「命令预览」（§4.2 / §5.4）。
3. **rule.json 写命令（已确认无）**：`ocr rules` 只有 `check` 子命令，无 `set/write`。坐实 §4.3 直接读写文件方案。
4. **Windows 二进制解析（已确认）**：`ocr` / `ocr.cmd` / `ocr.ps1` 共存，`where ocr` 二者均返回。后端统一用 `cmd /c ocr <args>` 执行。
5. **`--language` 不存在（已确认）**：`ocr review --help` 无 `--language`，`config` 也无 language 键；审查语言非本应用配置项，Params Tab 不纳入。

> **安全纪律（实测教训）**：探索真实 CLI 时**绝不直接执行会写入配置的命令**（曾误执行 `ocr config set providers.anthropic.api_key foo` 污染用户全局配置，已修复）。探测一律用 `--help`、临时隔离的 config 副本或 dry-run；任何 `ocr config set/unset` 只在本应用的「用户显式点击保存」路径下执行。

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

## 12. 工具链方案（实现期实测确定）

原计划用 MSVC，但本机 MSVC 工具缺失且补装需 UAC 提权——无人值守环境无法确认（安装器被动模式报 5007，提权模式 ExitCode 1、进程秒退、无新日志）。改为 GNU target 后，逐一排除了以下失败路径，最终确定 LLVM-MinGW：

| 尝试 | 结果 |
|---|---|
| MSVC（VS2019 补装） | UAC 无法确认 → 不可行 |
| MinGW-w64 8.1.0 的 ld | 不识别 Tauri 的 MSVC `.res` 资源库（`resource.lib: file format not recognized`） |
| MinGW 8.1.0 + rust-lld（gnu-lld flavor） | 能编译，但产物在 Win11 崩 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` |
| gnu host + MinGW 8.1.0 ld | build script 自身崩 `0xc0000139`（旧 MinGW 链接的复杂产物在 Win11 崩） |
| **LLVM-MinGW 20260922（clang 23 + lld）** | ✅ 编译通过；主程序在 Win11 正常运行；集成测试通过 |

**根因**：MinGW-w64 8.1.0（binutils 2.30，2018）太旧，与 Win11 加载器/现代 lld 不兼容；本环境可下载的新版本只有 LLVM-MinGW（GitHub release 可达，sourceforge 仅 8.1.0）。

**最终方案与依赖**：
- **LLVM-MinGW** `llvm-mingw-20260922-ucrt-x86_64` 解压于 `C:/Users/Jeffery/llvm-mingw/`（clang/lld/windres/ar 一站式，无需 MSVC、无需 UAC）
- 需补 `libgcc_eh.a`：Rust 的 `x86_64-pc-windows-gnu` target 链接 `-lgcc -lgcc_eh`，而 LLVM-MinGW 用 compiler-rt（无 libgcc）。把 LLVM-MinGW 的 `libunwind.a` 复制为 `libgcc_eh.a`（提供 `_Unwind_*`），`libgcc.a` 用空归档占位。
- **gnu host 工具链** `nightly-x86_64-pc-windows-gnu`：使 build script（embed-resource）以 `target_env=gnu` 编译，走 `windres` 生成 GNU 格式资源（而非 MSVC `.res`），LLVM-MinGW 才能链接。
- **`.cargo/config.toml`**：`[build] target = "x86_64-pc-windows-gnu"`；linker 指向 LLVM-MinGW 的 `x86_64-w64-mingw32-gcc.exe`；补 lib 搜索路径。

**编译/测试命令**：
```bash
export PATH="$HOME/.cargo/bin:$HOME/llvm-mingw/llvm-mingw-20260922-ucrt-x86_64/bin:$PATH"
cd src-tauri
cargo +nightly-x86_64-pc-windows-gnu build                 # 构建
cargo +nightly-x86_64-pc-windows-gnu test --no-default-features   # 测试
npm run build                                              # 前端
```

**已知边角限制**：带 `tauri` feature 的**测试**二进制在本机仍崩 `0xc0000139`（链接 tauri 的测试 harness 与 Win11 加载器的边角问题），故测试用 `--no-default-features`（Cargo.toml 中 `tauri` 设为 optional，`default = ["tauri"]`）。主程序与前端不受影响。
