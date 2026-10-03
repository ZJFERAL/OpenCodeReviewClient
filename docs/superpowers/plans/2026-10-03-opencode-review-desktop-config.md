# Open Code Review 桌面端配置器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Tauri 2 桌面应用，以可视化表单管理 Open Code Review（`ocr` CLI）的 LLM Provider 配置、`rule.json` 审查规则，以及可持久化的审查参数（max_tokens / effort），并提供连接测试与规则命中验证。

**Architecture:** 三层结构——React + Vite 前端只负责表单与展示；Rust 后端（Tauri commands）是唯一允许 spawn `ocr` 的层，统一用 `cmd /c ocr <args>` 在 Windows 上执行，并直接读写 `~/.opencodereview/{config.json,rule.json}`（无 `ocr config get`，规则无写命令）；前端通过 Tauri IPC `invoke` 与后端通信，绝不碰文件系统或进程。

**Tech Stack:** Tauri 2.x、React 18、Vite、TypeScript、Rust（tauri 2 crate + tauri-build）、Vitest（前端单测）、Tauri 集成测试（mock ocr 二进制）。

**Spec:** `docs/superpowers/specs/2026-10-03-opencode-review-desktop-config-design.md`（本计划的所有命令语法、可持久化键、Windows 执行方式均来自 spec §8 实测结论，spec 与该计划配套阅读）

## 全局约束（来自 spec，逐条强制）

- 后端执行 `ocr` 一律用 `cmd /c ocr <args>`（Windows `.cmd` 陷阱，spec §8.4 / §7）。
- 读配置**只能**直接解析 `~/.opencodereview/config.json`（无 `ocr config get`，spec §3）。
- 可 `config set` 持久化的键**仅**：`provider`、`model`、`max_tokens`、`effort`、`providers.<name>.api_key`、`custom_providers.<name>.{url,protocol}`（spec §8.2）。`timeout`/`concurrency`/`format`/`exclude` 仅 `ocr review` 运行时 flag，不可持久化，只能生成命令预览。
- rule.json 直接读写文件（无写命令），结构 `{rules:[{path,rule,merge_system_rule}]}`（spec §4.3）。
- API Key 在 UI 中**永远掩码**，不回显明文（spec §7）。
- **安全纪律**：任何 `ocr config set/unset` 只在用户显式点击「保存」时执行；实现与测试阶段不得为探测而写配置。任何临时改动必须立即还原（spec §7 / §8 实测教训）。
- 主目标平台 Windows 11；本机已装 `ocr v1.12.11`，但**缺失 Rust 工具链**（实现第一步硬阻塞）。
- 语言规则：用户要求最终回答与推理用简体中文；代码注释用简体中文，技术术语保留英文。

## 审查焦点（spec 未明言但最易在实际使用中被打垮的 5 处）

1. **未装 ocr 时应用必须能开、不崩**——启动 `probe_ocr` 失败要降级为「禁用配置 + 引导安装」，而非白屏或崩溃。（见 Task 2）
2. **用户填了错误 provider 名称或坏 key**——保存后 `ocr config set` 失败要能定位到具体字段并中文提示，而非整窗报错。（见 Task 4 / Task 5）
3. **rule.json 被手改坏（非法 JSON）**——`get_rules` 读取要捕获解析失败并提示「是否重置为空」，而非抛异常 crash。（见 Task 6）
4. **切换仓库级规则时 repo 目录选错/不存在**——`get_rules(repo)` 要在目录不存在或 `.opencodereview` 缺失时返回空规则集而非报错。（见 Task 6）
5. **Windows 下 ocr 命令找不到**——后端若直接 `Command::new("ocr")` 会失败；必须用 `cmd /c ocr`。集成测试用 mock 验证此拼装。（见 Task 2 / Task 9）

---

## Task 1：安装 Rust 工具链并验证 Tauri 前置

**Files:**
- 无代码文件；产出为本地环境状态（Rustup + MSVC）。

**Interfaces:**
- 产出：本地具备 `rustc` / `cargo` / `cargo tauri` 可用；后续所有 Rust 任务依赖此。

- [ ] **Step 1：安装 Rustup 稳定工具链**
  运行：`https://rustup.rs` 安装器，选 default + MSVC target（`stable-x86_64-pc-windows-msvc`）；并安装 VS Build Tools 的「C++ 构建工具 + Windows 10/11 SDK」。
  验证：`rustc --version` 与 `cargo --version` 均输出版本号。

- [ ] **Step 2：安装 Tauri CLI**
  运行：`npm install -g @tauri-apps/cli@latest`（或 `cargo install tauri-cli`）。
  验证：`cargo tauri --version` 或 `tauri --version` 输出版本（2.x）。

- [ ] **Step 3：确认 Windows WebView2 运行时存在**
  验证：`powershell -c "Get-AppxPackage *WebView2*"` 或确认系统已装；缺失则装 Evergreen Bootstrapper。

- [ ] **Step 4：记录环境到 README/notes（可选）**
  在 `docs/` 下写一行环境确认记录（rustc/cargo/tauri 版本）。

> 说明：此 Task 是纯环境准备，无可写单测。完成标志为三条命令可用。

---

## Task 2：初始化 Tauri 2 项目骨架（空窗口 + 三 Tab 容器 + 顶部状态条）

**Files:**
- Create: `package.json`、`vite.config.ts`、`tsconfig.json`、`tsconfig.node.json`、`index.html`
- Create: `src/main.tsx`、`src/App.tsx`、`src/styles.css`
- Create: `src/components/StatusBar.tsx`
- Create: `src/ipc.ts`（定义 `OcrResult` 类型 + `invoke` 封装，见下）
- Create: `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/build.rs`、`src-tauri/src/main.rs`、`src-tauri/src/lib.rs`（Tauri 2 用 `lib.rs` + `main.rs` 入口）
- Create: `src-tauri/src/ocr.rs`、`src-tauri/src/commands.rs`（先留空 command 桩）

**Interfaces:**
- 前端 `OcrResult` 类型（贯穿所有后续任务）：
  ```ts
  export type OcrResult = {
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    data?: unknown;
  };
  ```
- 前端 `ipc.ts` 提供 `invokeOcr(cmd: string, args?: unknown): Promise<OcrResult>` 封装 Tauri `invoke`，并统一解析返回。
- Rust 层 `run_ocr(args: &[&str]) -> Result<OcrResult, String>`（在 `ocr.rs`），后续所有 command 复用它。
- 后端入口 `src-tauri/src/lib.rs` 用 `#[cfg_attr(mobile, tauri::mobile_entry_point)] pub fn run()` 注册 commands。

- [ ] **Step 1：用 Tauri 2 脚手架创建项目**
  运行：`cargo tauri init`（或在空目录 `npm create tauri-app@latest`）生成上述骨架；确认 `tauri.conf.json` 的 `productName`/`identifier`/`frontendDist`/`devUrl` 正确指向 Vite。

- [ ] **Step 2：写 `OcrResult` 与 `ipc.ts`**
  在 `src/ipc.ts` 定义上述类型与 `invokeOcr` 封装（`invoke("run_ocr", { args })` 的薄包装，返回 `OcrResult`）。

- [ ] **Step 3：写 Rust `run_ocr`（此时为桩，仅拼装 `cmd /c ocr`）**
  在 `src-tauri/src/ocr.rs` 实现：
  ```rust
  use serde::Serialize;
  #[derive(Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct OcrResult { pub ok: bool, pub exitCode: i32, pub stdout: String, pub stderr: String, #[serde(skip_serializing_if = "Option::is_none")] pub data: Option<serde_json::Value> }
  pub fn run_ocr(args: &[&str]) -> Result<OcrResult, String> {
      let mut cmd = std::process::Command::new("cmd");
      cmd.arg("/c").arg("ocr");
      for a in args { cmd.arg(a); }
      // 返回 exit code + stdout/stderr；ocr 不存在则 err
  }
  ```
  用 `cmd /c ocr --version` 实测：Windows 下 `Command::new("ocr")` 找不到，必须 `cmd /c`（spec §8.4）。

- [ ] **Step 4：写 `App.tsx` 三 Tab 容器 + `StatusBar`**
  `App.tsx`：顶部 `StatusBar` + 三个 Tab 占位（`ProviderTab`/`RulesTab`/`ParamsTab` 先用空组件）。`StatusBar` 接收 `ocrInstalled: boolean` 与 `version?: string`，显示 `ocr ✓ vX` 或 `ocr ✗ 未安装 [去安装]`。

- [ ] **Step 5：`cargo tauri dev` 跑通空窗口**
  运行：`npm run tauri dev`（或 `cargo tauri dev`）。
  验证：原生窗口打开，三个 Tab 标签可见，状态条显示（此时 ocr 已装应显示 ✓）。

- [ ] **Step 6：Commit**
  ```bash
  git add -A
  git commit -m "feat: Tauri2 + React 骨架，空三 Tab 窗口与 run_ocr 桩"
  ```

---

## Task 3：`probe_ocr` 命令 + 启动加载 + 未安装引导

**Files:**
- Modify: `src-tauri/src/commands.rs`（新增 `probe_ocr` command）
- Modify: `src-tauri/src/ocr.rs`（`run_ocr` 已就绪，复用）
- Modify: `src/App.tsx`（挂载时 `invoke("probe_ocr")` 填状态条）
- Modify: `src/components/StatusBar.tsx`（未安装时显示引导按钮，点击触发 `npm i -g ...` 提示或外部链接）
- Test: `src-tauri/tests/probe_ocr_test.rs`（集成测试，用 mock ocr）

**Interfaces:**
- 消费：`run_ocr`（Task 2）。
- 产出：`probe_ocr` command：`fn probe_ocr() -> OcrResult`；`data` 字段为 `{ version: String }`（成功时）或 `null`。

- [ ] **Step 1：写 `probe_ocr` 集成测试（失败态 + 成功态，用 mock ocr）**
  在 `src-tauri/tests/probe_ocr_test.rs`：`PATH` 指到一个 fake `ocr` 目录，成功态 fake 打印 `open-code-review v9.9.9 ...`，失败态目录不含 ocr。`#[test] fn probe_ok()` 断言 `ok==true` 且 `data.version=="9.9.9"`；`#[test] fn probe_missing()` 断言 `ok==false` 且 `exitCode!=0`。
  测试通过 `Command::new("cmd").args(["/c","set PATH=...&& ocr --version"])` 或 rust 内临时 `env::set_var("PATH", mock_dir)` 实现 mock。

- [ ] **Step 2：Run 测试确认失败**（因 `probe_ocr` 未实现 / mock 未接）。

- [ ] **Step 3：实现 `probe_ocr`**
  在 `commands.rs`：`#[tauri::command] pub fn probe_ocr() -> OcrResult { let r = run_ocr(&["--version"]); ...解析首行版本号填入 data }`。

- [ ] **Step 4：Run 测试确认通过。**

- [ ] **Step 5：前端挂载调用 + 未安装 UI**
  `App.tsx` `useEffect` 调 `invoke("probe_ocr")`，结果写 state 传 `StatusBar`。`StatusBar` 未安装时渲染引导按钮（点击打开 `https://www.npmjs.com/package/@alibaba-group/open-code-review` 或提示 `npm i -g`）。

- [ ] **Step 6：`cargo tauri dev` 手动验证**——状态条显示 `ocr ✓ v1.12.11`（本机）；临时把 mock 缺失态切回验证逻辑（不污染真实配置）。

- [ ] **Step 7：Commit**
  ```bash
  git add -A
  git commit -m "feat: probe_ocr 探测与未安装引导状态条"
  ```

---

## Task 4：`get_config` 读配置 + Provider Tab 动态表单（只读展示）

**Files:**
- Modify: `src-tauri/src/commands.rs`（新增 `get_config`）
- Modify: `src-tauri/src/ocr.rs`（新增 `read_config_json()` 直接读 `~/.opencodereview/config.json`）
- Create: `src/tabs/ProviderTab.tsx`、`src/components/ProviderForm.tsx`
- Create: `src/types.ts`（`ProviderConfig` 类型）
- Test: `src-tauri/tests/get_config_test.rs`（mock config.json）
- Test: `src/tabs/ProviderForm.test.tsx`（Vitest：provider 类型切换字段联动）

**Interfaces:**
- 消费：`run_ocr`（Task 2）、`OcrResult`（Task 2）。
- 产出：
  - Rust `get_config() -> OcrResult`，`data` 为序列化的 `config.json` 内容（`{provider?, model?, max_tokens?, effort?, providers:{}, custom_providers:{}}`）。
  - TS 类型：
    ```ts
    export type ProviderConfig = {
      provider?: string;
      model?: string;
      maxTokens?: number;
      effort?: 'low'|'medium'|'high';
      providers?: Record<string,{api_key?:string}>;
      customProviders?: Record<string,{url?:string;protocol?:string}>;
    };
    ```

- [ ] **Step 1：写 `get_config` 集成测试（含损坏 JSON 场景）**
  `src-tauri/tests/get_config_test.rs`：mock 一个合法 `config.json` 与一个非法 JSON 文件，断言合法时 `data.provider` 正确、非法时 `ok==false` 且 stderr 含 `invalid json`（对应审查焦点 #3）。

- [ ] **Step 2：Run 测试确认失败。**

- [ ] **Step 3：实现 `read_config_json` + `get_config`**
  `ocr.rs`：`read_config_json()` 读 `HOME/.opencodereview/config.json`；文件不存在返回空 `{}`（spec §4.3 同类处理）；解析失败返回 `Err`（不 panic）。`commands.rs` 的 `get_config` 调它填 `data`。

- [ ] **Step 4：Run 测试确认通过。**

- [ ] **Step 5：写 `ProviderForm` 动态字段单测（Vitest）**
  `ProviderForm.test.tsx`：渲染 `<ProviderForm provider="anthropic"/>` 断言显示 API Key + Model 字段；切到 `provider="custom"` 断言显示 Gateway/URL/Protocol 字段、隐藏内置 key 字段（审查焦点无，但属核心联动）。

- [ ] **Step 6：Run vitest 确认通过。**

- [ ] **Step 7：实现 `ProviderTab` + `ProviderForm`（本 Task 仅展示，保存留 Task 5）**
  表单状态本地化；`useEffect` 加载 `invoke("get_config")` 填初值；api_key 输入 `type="password"` 掩码（spec §7）。

- [ ] **Step 8：`cargo tauri dev` 手动验证**——打开 Provider Tab 能看到从 `config.json` 读到的 provider（本机当前为空，字段为空占位）。

- [ ] **Step 9：Commit**
  ```bash
  git add -A
  git commit -m "feat: get_config 读取配置 + Provider Tab 动态表单展示"
  ```

---

## Task 5：保存 Provider（set 命令逐条 + `test_connection` + `list_providers`）

**Files:**
- Modify: `src-tauri/src/commands.rs`（新增 `set_provider`、`set_provider_key`、`set_custom_provider`、`set_model`、`test_connection`、`list_providers`）
- Modify: `src/tabs/ProviderTab.tsx`、`src/components/ProviderForm.tsx`（接入保存/测试按钮）
- Test: `src-tauri/tests/provider_save_test.rs`（mock ocr，断言 spawn 的 set 命令拼装正确）
- Test: `src/tabs/ProviderForm.test.tsx`（补充：点击保存触发正确的 invoke 参数）

**Interfaces:**
- 消费：`run_ocr`（Task 2）、`ProviderConfig`（Task 4）。
- 产出：commands：
  - `set_provider(provider: String) -> OcrResult` → `run_ocr(&["config","set","provider",provider])`
  - `set_provider_key(provider: String, key: String) -> OcrResult` → `run_ocr(&["config","set","providers.<provider>.api_key",key])`
  - `set_custom_provider(name: String, url: String, protocol: String) -> OcrResult` → 两条 `custom_providers.<name>.{url,protocol}`
  - `set_model(model: String) -> OcrResult` → `run_ocr(&["config","set","model",model])`（model 为空则跳过）
  - `test_connection() -> OcrResult` → `run_ocr(&["llm","test"])`；`data` 含 `{success:bool, message:String}`（解析输出）
  - `list_providers() -> OcrResult` → `run_ocr(&["llm","providers"])`；`data` 为 provider 列表数组（name/protocol/baseUrl）

- [ ] **Step 1：写保存拼装集成测试（mock ocr 记录收到参数）**
  `src-tauri/tests/provider_save_test.rs`：fake ocr 把收到的 `args` 回显到 stdout；调 `set_provider_key("anthropic","sk-xxx")` 断言 stdout 含 `providers.anthropic.api_key` 与 `sk-xxx`（审查焦点 #2：拼装正确）。`test_connection` mock 返回成功/失败两种输出，断言 `data.success` 解析。

- [ ] **Step 2：Run 测试确认失败。**

- [ ] **Step 3：实现 6 个 command**
  在 `commands.rs` 实现上述；`list_providers` 解析 `ocr llm providers` 的表格行（跳过表头，按空格分列取 name/protocol/baseUrl）。`test_connection` 解析退出码与输出关键词（如 `error`/`connection`）定 `success`。

- [ ] **Step 4：Run 集成测试确认通过。**

- [ ] **Step 5：前端接入保存与测试**
  `ProviderForm`「保存」：按表单状态逐条调用对应 command（先 `set_provider`，再 `set_provider_key`/`set_custom_provider`，再 `set_model`），任一失败定位字段 + 中文提示（审查焦点 #2）。「测试连接」调 `test_connection` 显示 ✓/✗。Provider 下拉数据来自 `list_providers`。

- [ ] **Step 6：Vitest 补充保存触发断言。**

- [ ] **Step 7：`cargo tauri dev` 手动验证**——**注意安全纪律**：手动验证用本机真实 ocr 即可，但测试完立即确认 `config.json` 无多余污染（本机初始 `{"providers":{},"llm":{}}`）。若测试时填了 key，验证后还原。

- [ ] **Step 8：Commit**
  ```bash
  git add -A
  git commit -m "feat: Provider 保存(set 逐条) + 连接测试 + 内置 provider 列表"
  ```

---

## Task 6：Rules Tab（global/repo 作用范围 + 规则表格 + 读写 + check）

**Files:**
- Modify: `src-tauri/src/commands.rs`（新增 `get_rules`、`set_rules`、`check_rules`）
- Modify: `src-tauri/src/ocr.rs`（新增 `read_rules(scope, repo_path?)`、`write_rules(...)`）
- Create: `src/tabs/RulesTab.tsx`、`src/components/RulesTable.tsx`
- Create: `src/types.ts`（增加 `Rule`、`RulesFile` 类型）
- Test: `src-tauri/tests/rules_test.rs`（合法/损坏/缺失目录三种）
- Test: `src/components/RulesTable.test.tsx`（增删改纯函数）

**Interfaces:**
- 消费：`run_ocr`（Task 2）。
- 产出：
  - `Rule = { path: string; rule: string; mergeSystemRule: boolean }`
  - `RulesFile = { rules: Rule[] }`
  - `get_rules(scope: "global"|"repo", repo_path?: String) -> OcrResult`，`data: RulesFile`；文件缺失返回 `{rules:[]}`（审查焦点 #4）；非法 JSON 返回 `ok:false`（审查焦点 #3）。
  - `set_rules(scope, repo_path?, rules: RulesFile) -> OcrResult`：写前校验每条 `path`/`rule` 非空、`mergeSystemRule` 为 bool（spec §4.3），校验失败 `ok:false` + stderr 定位行号。
  - `check_rules(file: String) -> OcrResult` → `run_ocr(&["rules","check",file])`，`data` 为命中规则文本。

- [ ] **Step 1：写 rules 集成测试（三类边界）**
  `src-tauri/tests/rules_test.rs`：
  - `get_rules` 合法 → `data.rules.length` 正确；
  - `get_rules` 损坏 JSON → `ok==false` 且 stderr 含 `invalid json`；
  - `get_rules(repo, 不存在目录)` → `ok==true` 且 `data.rules==[]`（审查焦点 #4）；
  - `set_rules` 含空 path → `ok==false` 且 stderr 含行号。

- [ ] **Step 2：Run 测试确认失败。**

- [ ] **Step 3：实现 `read_rules` / `write_rules` / 三 command**
  `ocr.rs`：global 路径 `HOME/.opencodereview/rule.json`，repo 路径 `<repo_path>/.opencodereview/rule.json`；`read_rules` 缺文件返回 `{rules:[]}`、损坏返回 Err。`write_rules` 先 serde 校验再写（原子写：先写临时文件再 rename）。

- [ ] **Step 4：Run 集成测试确认通过。**

- [ ] **Step 5：写 `RulesTable` 增删改单测（Vitest）**
  `RulesTable.test.tsx`：测试 `addRule`/`removeRule(index)`/`updateRule(index, patch)` 纯函数（不依赖 React 渲染）。

- [ ] **Step 6：Run vitest 确认通过。**

- [ ] **Step 7：实现 `RulesTab` + `RulesTable`**
  顶部作用范围切换（全局 / 选仓库目录，Tauri dialog 选目录）；表格行内编辑 path/rule/merge 开关；`+ 新增规则`；`保存规则文件` 调 `set_rules`；`验证命中` 选文件调 `check_rules` 展示结果。

- [ ] **Step 8：`cargo tauri dev` 手动验证**——加一条规则、保存、切仓库级读另一份（不污染全局，repo 用临时测试目录）。

- [ ] **Step 9：Commit**
  ```bash
  git add -A
  git commit -m "feat: Rules Tab 全局/仓库级规则读写 + ocr rules check 验证"
  ```

---

## Task 7：Params Tab（max_tokens/effort 持久化 + 命令预览）

**Files:**
- Modify: `src-tauri/src/commands.rs`（新增 `set_param` 复用 spec §3 `set_param`）
- Modify: `src/tabs/ParamsTab.tsx`
- Test: `src/tabs/ParamsTab.test.tsx`（Vitest：命令预览片段生成）
- Test: `src-tauri/tests/params_test.rs`（set_param 仅接受可持久化键）

**Interfaces:**
- 消费：`run_ocr`（Task 2）、`ProviderConfig` 的 maxTokens/effort（Task 4）。
- 产出：
  - `set_param(key: String, value: String) -> OcrResult`：仅允许 `max_tokens`/`effort`（白名单），否则 `ok:false` + stderr `unsupported key`（spec §8.2）。
  - 前端命令预览：把 timeout/concurrency/format/exclude 拼成 `ocr review --timeout 15 --concurrency 8 --format text --exclude "..."` 字符串，只读可复制。

- [ ] **Step 1：写 params 测试**
  `params_test.rs`：`set_param("max_tokens","200000")` 成功；`set_param("timeout","15")` 失败含 `unsupported key`。`ParamsTab.test.tsx`：断言预览串含各 flag 与值。

- [ ] **Step 2：Run 测试确认失败。**

- [ ] **Step 3：实现 `set_param`（白名单） + `ParamsTab`**
  表单：max_tokens（数字）、effort（下拉 low/medium/high）走 `set_param` 持久化；timeout/concurrency/format/exclude 仅生成命令预览（不写）。

- [ ] **Step 4：Run 两组测试确认通过。**

- [ ] **Step 5：`cargo tauri dev` 手动验证**——改 effort 保存后查 `config.json` 出现 `effort`；预览串正确。

- [ ] **Step 6：Commit**
  ```bash
  git add -A
  git commit -m "feat: Params Tab max_tokens/effort 持久化 + 不可持久化项命令预览"
  ```

---

## Task 8：前端单元 + 集成联调打磨（Toast/错误中文化/掩码复核）

**Files:**
- Create/Modify: `src/components/Toast.tsx`、`src/ipc.ts`（错误中文映射）
- Modify: `src/App.tsx`（Toast 容器）

**Interfaces:**
- 消费：所有 command 的 `OcrResult`（前序 Task）。
- 产出：`translateError(stderr) -> 中文提示`；全局 Toast 展示保存/测试结果。

- [ ] **Step 1：写 `translateError` 单测（Vitest）**
  断言 `command not found`→「未检测到 ocr」、`connection error`→「LLM 连接失败」、`unknown flag`→「不支持的参数」、`unsupported key`→「该参数不可持久化」。

- [ ] **Step 2：Run vitest 确认通过。**

- [ ] **Step 3：接入 Toast + 错误中文化 + 全局掩码复核**（api_key 全处 `type=password`）。

- [ ] **Step 4：全量 `cargo tauri dev` 走查三 Tab 一遍。**

- [ ] **Step 5：Commit**
  ```bash
  git add -A
  git commit -m "feat: 全局 Toast、错误中文化、掩码复核"
  ```

---

## Task 9：Tauri 集成测试完善 + Windows 打包

**Files:**
- Modify: `src-tauri/tauri.conf.json`（打包配置：identifier、Windows `msi`/`nsis` target、图标占位）
- Modify: `src-tauri/Cargo.toml`（release profile）
- Test: 补全 `src-tauri/tests/*.rs`（覆盖未安装/连接失败/规则损坏/缺失目录/非法 set key）

**Interfaces:**
- 消费：所有 commands（Task 3-7）。

- [ ] **Step 1：补全集成测试覆盖审查焦点 5 条**
  确保 Task 2-7 的测试合集覆盖：未安装降级、坏 key 定位、规则损坏、repo 缺失目录、Windows `cmd /c` 拼装。

- [ ] **Step 2：Run 全量 `cargo test`（tauri 集成测试）确认通过。**

- [ ] **Step 3：配置 `tauri.conf.json` Windows 打包**
  设 `bundle.targets: ["msi","nsis"]`，`identifier: "com.opencodereview.desktop"`（按用户实际改），填图标路径（先用占位）。

- [ ] **Step 4：`cargo tauri build` 产出 `.msi` / `.exe`**
  验证：安装后双击运行，三 Tab 正常、读本机 `config.json`。

- [ ] **Step 5：Commit**
  ```bash
  git add -A
  git commit -m "build: 完善集成测试 + Windows msi/nsis 打包配置"
  ```

---

## 计划自审结论（写于产出时）

- **Spec 覆盖**：目标三块（Provider/Rules/Params）+ 未安装引导 + rule.json 折中 + Windows 执行，均落到 Task 2-7；安全纪律写入全局约束与 Task 5/7 手动验证步骤。
- **步骤无空缺**：每 Task 含 失败测试→实现→通过→手动验证→commit；无 "TBD"/"适当处理" 空话。
- **类型一致**：`OcrResult`、`ProviderConfig`、`Rule/RulesFile` 在 Task 2/4/6 定义，后续复用同名同形。
- **审查焦点**：5 条全部映射到具体 Task 的测试（#1→T2/T3，#2→T4/T5，#3→T4/T6，#4→T6，#5→T2/T9）。
- **比例**：计划以签名/测试名/断言为主，未抄写函数体（算法由签名+测试决定），篇幅适度。
