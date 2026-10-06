# AGENTS.md

给在本仓库工作的 AI agent 与贡献者的说明。**先读本文件再动手。**

## 项目是什么

Tauri 2 + React 18 + Vite + TypeScript + Rust 的桌面应用，为 [`ocr` CLI](https://github.com/alibaba/open-code-review)（Open Code Review）提供可视化配置界面。

前端在 `src/`，Rust 后端在 `src-tauri/`。设计与计划文档在 `docs/superpowers/`。

## 环境与命令

- **平台**：Windows 11（主目标）。Shell 用 Git Bash。
- **Rust**：默认 toolchain 为 `stable-x86_64-pc-windows-msvc`（MSVC 工具链已就绪，见 `C:/Users/Jeffery/.kimi-code/MSVC-Windows-Toolchain.md`）。**不需要** `+nightly`，也**不需要**任何 GNU / LLVM-MinGW 配置。
- **Node**：18+。

### 构建与测试

```bash
npm install

npm run build                    # 前端类型检查 + 构建
npm test                         # 前端单测（Vitest，86 项）
npm run tauri dev                # 完整桌面应用（开发）
npm run tauri build              # 产出 msi / nsis 安装包

cd src-tauri && cargo test --no-default-features   # Rust 测试（43 项）
```

> **`--no-default-features` 不是可选项**：`tauri` 与 `tauri-plugin-dialog` 是 optional feature（默认开启，真实 app 需要）。Rust 测试必须关掉它们，否则测试二进制会链接 GUI 运行时。`ocr.rs` 的核心逻辑在两种组合下都编译，测试覆盖不受影响。

### 验证顺序（改完代码）

```bash
cd src-tauri && cargo test --no-default-features && cd ..
npm test && npm run build
```

两项都绿才算完成。**不要**只跑其中一项就宣称完成。

## 代码地图

| 文件 | 职责 |
|---|---|
| `src-tauri/src/ocr.rs` | **核心逻辑**。`run_ocr`（spawn `ocr.cmd`）、读写 `config.json` / `rule.json`、`set_*`、`probe_ocr`、版本与 provider 表格解析、`translateError` 的上游错误文案 |
| `src-tauri/src/commands.rs` | `#[tauri::command]` 薄壳，转调 `ocr.rs`。全部 `#[cfg(feature = "tauri")]` 门控 |
| `src-tauri/src/lib.rs` | 注册 command handlers（`generate_handler!`） |
| `src/ipc.ts` | 前端唯一 IPC 入口：`invoke*` 封装、`OcrResult` 类型、`normalizeConfig` / `normalizeRules` / `translateError` |
| `src/types.ts` | 共享类型（`ProviderConfig` / `Rule` / `RulesFile` / 常量） |
| `src/App.tsx` | 三 Tab 容器 + 顶部状态条 + 全局 Toast |
| `src/tabs/*.tsx` | Provider / Rules / Params 三个页面 |
| `src/components/*.tsx` | `ProviderForm` / `RulesTable` / `StatusBar` / `Toast` |
| `src/styles.css` | **全部样式**（mimo-design token + 组件样式，无 CSS-in-JS） |

## 硬规则（违反会出错）

### 1. 安全纪律：绝不写用户的真实 OCR 配置

- **任何 `ocr config set` / `unset` 只允许在用户显式点击「保存」时执行。**
- 实现与测试阶段**禁止**为探测而写 `~/.opencodereview/`。真实 CLI 行为探测一律用**隔离 HOME**：
  ```bash
  HOME=<临时目录> USERPROFILE=<临时目录> ocr config set ...
  ```
  Windows 上 ocr CLI 认 `USERPROFILE`（不是 `HOME`），两者都要设。
- 测试用 fake `ocr.cmd` 前置 PATH + 临时目录 mock，绝不碰真实配置。
- 历史上曾因误执行 `ocr config set` 污染过用户配置，已修复。**不要重蹈。**

### 2. `run_ocr` 直接 spawn `ocr.cmd`，不经 `cmd /c`

`src-tauri/src/ocr.rs` 的 `run_ocr` 用 `Command::new("ocr.cmd")` **直接执行**。

**不要**改回 `Command::new("cmd").arg("/c").arg("ocr")`——`cmd /c` 裸拼参数时，含 `&` `^` `|` 但**无空格**的值不会被加引号，会被 cmd 二次解析：`sk-abc&def=ghi` 会被截断成 `sk-abc` 并执行 `def=ghi`（凭据静默损坏 + 命令注入）。直接 spawn 时 Rust 会正确加引号转义。

回归测试：`src-tauri/tests/provider_save_test.rs` 的 `set_provider_key_preserves_special_chars`。

### 3. 真实 `config.json` schema（实测确认）

```
{
  "provider": "openai",                    // 顶层：当前 provider
  "providers": { "openai": { "api_key": "...", "model": "gpt-5" } },
  "custom_providers": { "mygw": { "url": "...", "protocol": "...", "model": "..." } },
  "max_tokens": 200000,
  "effort": "medium",
  "model": "..."                           // 仅当从未设过 provider 时才在顶层
}
```

**关键**：设了 provider 后，`model` 落在 `providers.<name>.model`（**不是**顶层）。`normalizeConfig` 的 `resolveModel` 按 `providers[n].model` → `custom_providers[n].model` → 顶层 `model` 兜底。

`ocr config set model <m>` 会**自动写入当前 provider 条目**——所以保存顺序必须 **provider 先行**（前端已是 `provider → custom → key → model → max_tokens/effort`）。

### 4. 可持久化键白名单

只有 `provider` / `model` / `max_tokens` / `effort` / `providers.<n>.api_key` / `custom_providers.<n>.*` 能 `config set`。

`set_param` 命令只接受 `max_tokens` / `effort`，其余键返回 `ok:false` + `unsupported key`。`timeout` / `concurrency` / `format` / `exclude` 只是 `ocr review` 的运行时 flag，**不能持久化**——只生成命令预览。

### 5. API Key 永不回读

`api_key` 输入一律 `type="password"`；`normalizeConfig` 只记录「是否存在」（置空串），不保留明文。空串语义 = 「未输入/不写入」，**不是**「用户主动清空」——保存时跳过，不覆盖已有 key。

### 6. 界面遵循 mimo-design

`src/styles.css` 使用 mimo-design 语义 token。改样式时：

- **主操作用墨黑 `--primary`（#000000），不用 accent。** 鼠尾草绿 `--accent`（#526E3E）只表示「live / 选中 / 链接」。
- 每屏彩色 ≤ 2（sage + orange）。焦点环用橙 `--signal`。
- 圆角只用 4 / 8 / 12 / 24 / 999px 五档，**禁用 13–23px**。按钮一律 pill。
- 标题用 `--font-display`（Georgia serif），正文 `--font-body`，数据/命令 `--font-mono`。
- 无发光、无彩色阴影、无渐变表面、无 emoji（图标用内联 Lucide SVG）。
- 浅色为主模式，暗色是 `prefers-color-scheme: dark` 的派生（`#0A0A0A` 纸）。

### 7. 测试靠文本 / label / role，不靠 class

前端测试（Vitest + Testing Library）用 `getByLabelText("API Key")`、`getByRole("button", { name: "保存规则文件" })`、`getByText("Open Code Review 配置器")` 等查询。

**改 UI 时不要改这些文案或删除 `aria-label`**，否则测试会红。CSS class 可自由改（唯一例外：`Toast.test.tsx` 断言了 `.toast` + `.toast-error` 两个 class 名）。

## 已知坑

- **`ocr` 版本漂移**：`ocr` 升级后 CLI 输出文案可能变，`translateError` 的关键词映射（在 `src/ipc.ts`）需同步。中文 Windows 的 cmd 报错是 GBK 字节，`from_utf8_lossy` 后成乱码，故映射里有与代码页无关的 U+FFFD 兜底。
- **`dirs::home_dir()` 忽略 `HOME`**：Windows 上走 `SHGetKnownFolderPath`。新增「写全局路径」的测试时，设 `HOME` **无法**隔离，会写真实 `~/.opencodereview/`——务必用可注入路径的 `*_at` 变体（如 `read_rules_at`）。
- **`src-tauri/gen/schemas/*.json`** 是 Tauri 构建时自动生成的，跑 `tauri dev` 会重写它们；提交前 `git restore` 掉无关改动。
- **`target/` / `dist/` / `node_modules/`** 已 gitignore，不要提交。

## 提交约定

- 提交信息用简体中文，格式 `<type>: <描述>`（`feat` / `fix` / `style` / `docs` / `refactor` / `test` / `build`）。
- 代码注释用简体中文；技术术语（API 名、路径、命令）保留英文。
- 一次提交聚焦一件事。
