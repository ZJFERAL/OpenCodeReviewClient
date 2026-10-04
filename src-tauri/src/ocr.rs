use serde::Serialize;
use std::path::{Path, PathBuf};

// 贯穿所有后续任务的核心结果类型（与前端 src/ipc.ts 的 OcrResult 对应）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub ok: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

// 拼装 `cmd /c ocr <args>` 并执行，返回退出码 + 标准输出/错误。
// Windows 下 `Command::new("ocr")` 找不到可执行文件，必须经由 `cmd /c`（spec §8.4）。
// 当前为桩：不实际运行 ocr 命令，仅在 ocr 缺失时报告错误。
pub fn run_ocr(args: &[&str]) -> Result<OcrResult, String> {
    let mut cmd = std::process::Command::new("cmd");
    cmd.arg("/c").arg("ocr");
    for a in args {
        cmd.arg(a);
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    match cmd.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let code = output.status.code().unwrap_or(-1);
            let ok = output.status.success();
            Ok(OcrResult {
                ok,
                exit_code: code,
                stdout,
                stderr,
                data: None,
            })
        }
        Err(e) => Err(format!("无法执行 ocr（cmd /c ocr 失败）：{e}")),
    }
}

// 从 `ocr --version` 输出首行提取语义版本号（如 `open-code-review v1.12.11` → `1.12.11`）。
// 零依赖实现：扫描首行，定位 `v` 后接 `数字.数字` 的片段并取整段（含可选第三级与预发布标签）。
pub fn parse_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return None;
    }
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // 找到 `v` 紧跟着数字的位置（`v` 可省略，但需确保数字前不是字母，避免误抓普通词）。
        let starts_v = chars[i] == 'v'
            && i + 1 < chars.len()
            && chars[i + 1].is_ascii_digit();
        let starts_digit = chars[i].is_ascii_digit()
            && (i == 0 || !chars[i - 1].is_ascii_alphabetic());
        if !starts_v && !starts_digit {
            i += 1;
            continue;
        }
        let num_start = if starts_v { i + 1 } else { i };
        // 版本号主体：`数字(.\d+)*`，之后可接预发布/构建标签 `[-+][0-9A-Za-z.\-]+`。
        let mut j = num_start;
        let mut dots = 0;
        while j < chars.len() {
            let c = chars[j];
            if c.is_ascii_digit() {
                j += 1;
            } else if c == '.' && j + 1 < chars.len() && chars[j + 1].is_ascii_digit() {
                dots += 1;
                j += 1;
            } else {
                break;
            }
        }
        if dots >= 1 && j > num_start {
            // 续接预发布/构建标签。
            if j < chars.len() && (chars[j] == '-' || chars[j] == '+') {
                let mut k = j + 1;
                while k < chars.len() && (chars[k].is_ascii_alphanumeric() || matches!(chars[k], '.' | '-')) {
                    k += 1;
                }
                return Some(chars[num_start..k].iter().collect());
            }
            return Some(chars[num_start..j].iter().collect());
        }
        i = if starts_v { i + 1 } else { num_start + 1 };
    }
    None
}

// 探测 ocr 是否可用并解析版本号。
// 复用 `run_ocr(&["--version"])`，成功（exit 0）时把版本写入 `data: { version }`；
// 版本解析失败（stdout 无 vX.Y.Z）时以空串 "" 归一，保证契约里 `version` 恒为 String，
// 绝不序列化为 JSON null。否则（exit≠0）`data` 留空。返回 `Result<OcrResult, String>`。
pub fn probe_ocr() -> Result<OcrResult, String> {
    let mut r = run_ocr(&["--version"])?;
    if r.ok {
        r.data = Some(serde_json::json!({ "version": parse_version(&r.stdout).unwrap_or_default() }));
    }
    Ok(r)
}

// 解析 `~/.opencodereview/config.json` 的绝对路径。
// 主用 `dirs::home_dir()`（跨平台）；它不可得时回退 `HOME` / `USERPROFILE` 环境变量。
pub fn config_path() -> PathBuf {
    let home = dirs::home_dir().or_else(|| {
        std::env::var("HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("USERPROFILE").ok().filter(|s| !s.is_empty()))
            .map(PathBuf::from)
    });
    match home {
        Some(h) => h.join(".opencodereview").join("config.json"),
        None => PathBuf::from(".opencodereview").join("config.json"),
    }
}

// 「无需执行 ocr」的成功结果：用于空串语义下的跳过分支（model / api_key 为空 = 不写入）。
// 绝不 spawn ocr，从而不会覆盖用户已有的 key。data.skipped = true 供前端识别。
fn skipped_result() -> OcrResult {
    OcrResult {
        ok: true,
        exit_code: 0,
        stdout: String::new(),
        stderr: String::new(),
        data: Some(serde_json::json!({ "skipped": true })),
    }
}

// `config set provider <name>`：切换当前生效的 provider。
pub fn set_provider(provider: &str) -> Result<OcrResult, String> {
    run_ocr(&["config", "set", "provider", provider])
}

// `config set providers.<provider>.api_key <key>`：写入某内置 provider 的 key。
// 实测键路径（隔离 HOME）：真实 config.json 里 key 落在 providers.<name>.api_key。
// 空串 key = 「未输入」，跳过、不覆盖已存在的 key（Task 4 reviewer 明确）。
pub fn set_provider_key(provider: &str, key: &str) -> Result<OcrResult, String> {
    if key.is_empty() {
        return Ok(skipped_result());
    }
    let path = format!("providers.{provider}.api_key");
    run_ocr(&["config", "set", &path, key])
}

// 写入自定义网关：`custom_providers.<name>.{protocol,url}`（实测落盘位置）。
// 顺序：**先 protocol 再 url**——ocr 无事务/回滚；实测缺 protocol 时该网关不可用，
// 故优先保证 protocol 落地；若后写 url 失败，网关已有可用 protocol，半状态影响更小。
// 任一字段失败即返回该失败结果，并把字段名 + 「可能半完成」提示写进 stderr 便于 UI 定位
// （审查焦点 #2 / I1）。两条命令的 stdout/stderr 合并，便于调用方/测试一次看到全部下发内容。
pub fn set_custom_provider(name: &str, url: &str, protocol: &str) -> Result<OcrResult, String> {
    let fields = [
        (format!("custom_providers.{name}.protocol"), protocol),
        (format!("custom_providers.{name}.url"), url),
    ];
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = 0;
    for (path, value) in fields {
        let r = run_ocr(&["config", "set", &path, value])?;
        stdout.push_str(&r.stdout);
        if !r.ok {
            stderr.push_str(&format!(
                "{path}: {}（自定义网关配置可能处于半完成状态，请重试保存）\n",
                r.stderr.trim()
            ));
            return Ok(OcrResult {
                ok: false,
                exit_code: r.exit_code,
                stdout,
                stderr,
                data: None,
            });
        }
        exit_code = r.exit_code;
    }
    Ok(OcrResult {
        ok: true,
        exit_code,
        stdout,
        stderr,
        data: None,
    })
}

// `config set model <model>`：设置当前生效的 model。
// 实测：设过 provider 后，该命令会写进 providers.<name>.model 或 custom_providers.<name>.model。
// 空串 = 「不写入」，跳过（不触发 ocr）。
pub fn set_model(model: &str) -> Result<OcrResult, String> {
    if model.is_empty() {
        return Ok(skipped_result());
    }
    run_ocr(&["config", "set", "model", model])
}

// Params Tab（spec §4.2 / §8.2）：仅 `max_tokens` / `effort` 可经 `config set` 持久化。
// 白名单硬编码——隔离 HOME 实测：`timeout`/`concurrency`/`format`/`exclude` 是 `ocr review`
// 的运行时 flag，`config set` 会报 `unknown config key`；故在此于 spawn 前拒绝，
// 绝不把非法键下发给真实 CLI（安全纪律 + 不给用户制造误导性报错）。
pub fn set_param(key: &str, value: &str) -> Result<OcrResult, String> {
    let v = value.trim();
    match key {
        "max_tokens" => {
            if v.is_empty() {
                return Ok(skipped_result());
            }
            run_ocr(&["config", "set", "max_tokens", v])
        }
        "effort" => {
            if v.is_empty() {
                return Ok(skipped_result());
            }
            if !matches!(v, "low" | "medium" | "high") {
                return Ok(OcrResult {
                    ok: false,
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: format!("unsupported value: {v}（effort 只能是 low / medium / high）"),
                    data: None,
                });
            }
            run_ocr(&["config", "set", "effort", v])
        }
        other => Ok(OcrResult {
            ok: false,
            exit_code: 1,
            stdout: String::new(),
            stderr: format!(
                "unsupported key: {other}（仅 max_tokens / effort 可持久化；\
                 timeout/concurrency/format/exclude 是 ocr review 运行时 flag，请用命令预览）"
            ),
            data: None,
        }),
    }
}

// 判定一行是否为「连接测试成功」的正向标记行。
// 隔离 HOME 实测：成功 stdout 末段为 `✓ Connection test successful`（✓ = U+2713），
// 失败则 exit≠0 且 stderr 含 `Error:`。故以退出码为主信号 + 正向标记为辅，避免
// 仅靠「不含 error」的负向判定（如模型回复里恰好出现 "error" 就会误判失败）。
fn is_success_marker_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("successful") || line.contains('✓')
}

// `llm test`：向当前配置的 LLM 发一条测试对话。
// success = 退出码 0 且 stdout/stderr 合并体含正向成功标记（`successful` 或 `✓`）。
// message：优先取含成功标记的那一行（避免拿到 `Source: ...` 之类前导行），
// 找不到再回退首个非空行；失败时取 stderr（为空则取 stdout）。
// data = { success: bool, message: String }。
pub fn test_connection() -> Result<OcrResult, String> {
    let mut r = run_ocr(&["llm", "test"])?;
    let combined_has_marker = r.stdout.lines().chain(r.stderr.lines()).any(is_success_marker_line);
    let success = r.ok && combined_has_marker;
    let message = if success {
        r.stdout
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && is_success_marker_line(l))
            .or_else(|| r.stdout.lines().map(str::trim).find(|l| !l.is_empty()))
            .unwrap_or("")
            .to_string()
    } else {
        let err = r.stderr.trim();
        if err.is_empty() {
            r.stdout.trim().to_string()
        } else {
            err.to_string()
        }
    };
    r.data = Some(serde_json::json!({ "success": success, "message": message }));
    Ok(r)
}

// 解析 `ocr llm providers` 的表格：跳过标题/表头/分隔行与尾部图例行，按列取
// name / protocol / baseUrl。判定「数据行」的规则：首列是合法 provider 名
// （全小写字母/数字/连字符且含至少一个字母数字），于是 `NAME`/`----`/`Use ...`/
// `Built-in providers:` 这些行自然被排除。缺列（如 bedrock 无 Base URL）归一为空串。
pub fn parse_providers_table(stdout: &str) -> Vec<serde_json::Value> {
    let mut rows = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut cols = trimmed.split_whitespace();
        let Some(name) = cols.next() else { continue };
        let is_provider_name = name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && name.chars().any(|c| c.is_ascii_alphanumeric());
        if !is_provider_name {
            continue;
        }
        let protocol = cols.next().unwrap_or("");
        let base_url = cols.next().unwrap_or("");
        rows.push(serde_json::json!({
            "name": name,
            "protocol": protocol,
            "baseUrl": base_url,
        }));
    }
    rows
}

// `list_providers`：跑 `ocr llm providers`，成功时把解析后的表格放进 data（数组）。
pub fn list_providers() -> Result<OcrResult, String> {
    let mut r = run_ocr(&["llm", "providers"])?;
    if r.ok {
        r.data = Some(serde_json::Value::Array(parse_providers_table(&r.stdout)));
    }
    Ok(r)
}

// 从指定路径读配置 JSON。
// - 文件不存在 → 空对象 `{}`（spec §4.3 同类「缺失即空」处理）
// - 内容非法 → `Err`，消息含 `invalid json`（供 UI 提示，不 panic）
pub fn read_config_json_at(path: &Path) -> Result<serde_json::Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            if text.trim().is_empty() {
                return Ok(serde_json::json!({}));
            }
            serde_json::from_str(&text)
                .map_err(|e| format!("invalid json in {}: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("无法读取 {}: {e}", path.display())),
    }
}

// 读真实 `~/.opencodereview/config.json`（路径由 config_path 解析）。
pub fn read_config_json() -> Result<serde_json::Value, String> {
    read_config_json_at(&config_path())
}

// `get_config` command 的实现体（与 Tauri 解耦，便于无 feature 集成测试直接调用）。
// 成功：ok=true，data = 解析后的配置对象；失败：ok=false，stderr 携带原因（含 `invalid json`）。
pub fn get_config_result_at(path: &Path) -> OcrResult {
    match read_config_json_at(path) {
        Ok(data) => OcrResult {
            ok: true,
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            data: Some(data),
        },
        Err(msg) => OcrResult {
            ok: false,
            exit_code: 1,
            stdout: String::new(),
            stderr: msg,
            data: None,
        },
    }
}

pub fn get_config_result() -> OcrResult {
    get_config_result_at(&config_path())
}

// ---- 审查规则 rule.json（spec §4.3：直接读写文件，其余全走 CLI）----
//
// 真实结构（隔离 HOME 实测 ocr v1.12.11）：
//   {"rules":[{"path":"**/*.java","rule":"...","merge_system_rule":true}]}
// 键名 snake_case；`merge_system_rule` 为 bool，可省略（缺省等价 false = 不合并系统规则）。
// 前端契约用 camelCase `mergeSystemRule`（src/types.ts），读写时在此做键名映射。

// 解析规则文件路径：global → `~/.opencodereview/rule.json`；
// repo → `<repo_path>/.opencodereview/rule.json`（scope=repo 时 repo_path 必填）。
pub fn rules_path_for(scope: &str, repo_path: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => {
            let home = dirs::home_dir().or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| std::env::var("USERPROFILE").ok().filter(|s| !s.is_empty()))
                    .map(PathBuf::from)
            });
            match home {
                Some(h) => Ok(h.join(".opencodereview").join("rule.json")),
                None => Ok(PathBuf::from(".opencodereview").join("rule.json")),
            }
        }
        "repo" => {
            let repo = repo_path
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "仓库级规则需要提供 repo_path（未选择仓库目录）".to_string())?;
            Ok(PathBuf::from(repo).join(".opencodereview").join("rule.json"))
        }
        other => Err(format!("未知的作用范围 scope：{other}（应为 global 或 repo）")),
    }
}

// 把文件里的单条规则归一为前端契约形状：
//   { path: String, rule: String, mergeSystemRule: bool }
// 键名兼容 snake_case（真实落盘）与 camelCase；merge 缺省为 false。
fn normalize_rule(v: &serde_json::Value) -> serde_json::Value {
    let obj = v.as_object();
    let str_field = |k: &str| -> String {
        obj.and_then(|o| o.get(k))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };
    let merge = obj
        .and_then(|o| o.get("merge_system_rule").or_else(|| o.get("mergeSystemRule")))
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    serde_json::json!({
        "path": str_field("path"),
        "rule": str_field("rule"),
        "mergeSystemRule": merge,
    })
}

// 读规则 JSON：
// - 文件不存在 → `{ "rules": [] }`（spec §4.3「缺失即空」）
// - 内容非法 → `Err`，消息含 `invalid json`（供 UI 提示，不 panic）
// - 合法 → 归一为 `{ "rules": [{path, rule, mergeSystemRule}] }`
pub fn read_rules_at(path: &Path) -> Result<serde_json::Value, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::json!({ "rules": [] }));
        }
        Err(e) => return Err(format!("无法读取 {}：{e}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(serde_json::json!({ "rules": [] }));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("invalid json in {}: {e}", path.display()))?;
    // 读取路径宽松：rules 缺失/非数组时归一为空列表，而不是报错。
    let rules = parsed
        .get("rules")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(normalize_rule).collect::<Vec<_>>())
        .unwrap_or_default();
    Ok(serde_json::json!({ "rules": rules }))
}

// `get_rules` 的实现体（无 tauri 依赖，便于集成测试）。
pub fn read_rules_result_at(path: &Path) -> OcrResult {
    match read_rules_at(path) {
        Ok(data) => OcrResult {
            ok: true,
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            data: Some(data),
        },
        Err(msg) => OcrResult {
            ok: false,
            exit_code: 1,
            stdout: String::new(),
            stderr: msg,
            data: None,
        },
    }
}

// `get_rules(scope, repo_path?)`：解析路径后读取；repo 目录不存在时同样返回空规则集（审查焦点 #4）。
pub fn get_rules_result(scope: &str, repo_path: Option<&str>) -> OcrResult {
    match rules_path_for(scope, repo_path) {
        Ok(path) => read_rules_result_at(&path),
        Err(msg) => OcrResult {
            ok: false,
            exit_code: 1,
            stdout: String::new(),
            stderr: msg,
            data: None,
        },
    }
}

// 校验并落盘规则文件。写前逐条校验（spec §4.3：path 必填非空、rule 必填非空、
// mergeSystemRule 为 bool）；失败消息带「第 N 条规则」与行号，供 UI 定位。
// 原子写：先写同目录临时文件，再 rename 覆盖，避免半写坏文件。
pub fn write_rules_at(path: &Path, rules: &serde_json::Value) -> Result<(), String> {
    let arr = rules
        .get("rules")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "规则文件格式错误：缺少 `rules` 数组".to_string())?;

    // 先构造「用于行号定位」的缩进渲染，数组里每个元素占一行 `    {`。
    let pretty_for_lines = serde_json::to_string_pretty(&serde_json::json!({ "rules": arr }))
        .unwrap_or_default();
    let rule_line_numbers = rule_start_lines(&pretty_for_lines);

    let mut out: Vec<serde_json::Value> = Vec::with_capacity(arr.len());
    for (i, r) in arr.iter().enumerate() {
        let line = rule_line_numbers.get(i).copied().unwrap_or(0);
        let obj = r
            .as_object()
            .ok_or_else(|| format!("第 {} 条规则（约第 {} 行）不是对象", i + 1, line))?;
        let p = obj.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if p.trim().is_empty() {
            return Err(format!("第 {} 条规则（约第 {} 行）：path 不能为空", i + 1, line));
        }
        let rule = obj.get("rule").and_then(|v| v.as_str()).unwrap_or("");
        if rule.trim().is_empty() {
            return Err(format!("第 {} 条规则（约第 {} 行）：rule 不能为空", i + 1, line));
        }
        let merge = obj
            .get("mergeSystemRule")
            .or_else(|| obj.get("merge_system_rule"))
            .and_then(|v| v.as_bool())
            .ok_or_else(|| {
                format!(
                    "第 {} 条规则（约第 {} 行）：mergeSystemRule 必须为布尔值（true/false）",
                    i + 1,
                    line
                )
            })?;
        // 回写真实落盘键名（snake_case）。
        out.push(serde_json::json!({
            "path": p,
            "rule": rule,
            "merge_system_rule": merge,
        }));
    }

    let text = serde_json::to_string_pretty(&serde_json::json!({ "rules": out }))
        .map_err(|e| format!("序列化规则失败：{e}"))?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录 {}：{e}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("json.tmp{}", std::process::id()));
    std::fs::write(&tmp, text.as_bytes())
        .map_err(|e| format!("无法写入临时文件 {}：{e}", tmp.display()))?;
    // 原子写：同目录临时文件 + rename 覆盖。
    // Rust 的 fs::rename 在 Windows 上走 MoveFileExW(MOVEFILE_REPLACE_EXISTING)，
    // 可直接原子覆盖已存在的目标文件（实测返回 OK），故无需先删除旧文件——
    // 「删除→rename」两步反而会露出「删除成功、rename 前崩溃 → 原文件丢失」的窗口。
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("无法写回 {}：{e}", path.display())
    })
}

// 从缩进序列化结果里取每个数组元素 `    {` 的 1-based 行号。
fn rule_start_lines(pretty: &str) -> Vec<usize> {
    pretty
        .lines()
        .enumerate()
        .filter(|(_, l)| *l == "    {")
        .map(|(idx, _)| idx + 1)
        .collect()
}

// `set_rules(scope, repo_path?, rules)` 的实现体。
pub fn set_rules_result(scope: &str, repo_path: Option<&str>, rules: &serde_json::Value) -> OcrResult {
    let path = match rules_path_for(scope, repo_path) {
        Ok(p) => p,
        Err(msg) => {
            return OcrResult {
                ok: false,
                exit_code: 1,
                stdout: String::new(),
                stderr: msg,
                data: None,
            };
        }
    };
    match write_rules_at(&path, rules) {
        Ok(()) => OcrResult {
            ok: true,
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            data: None,
        },
        Err(msg) => OcrResult {
            ok: false,
            exit_code: 1,
            stdout: String::new(),
            stderr: msg,
            data: None,
        },
    }
}

// 从文件路径向上回溯，找最近的包含 `.git` 的目录（git 仓库根）。
// I2：`ocr rules check <file>` 无 `--repo` 时以 **cwd** 定位仓库；GUI 进程 cwd
//（安装目录/target）通常不是 git 仓库 → CLI 报 `... is not a git repository`。
// 故这里显式回溯出 file 所属仓库根，回传为 `--repo`。找不到 git 根返回 None。
pub fn find_git_root(file: &str) -> Option<PathBuf> {
    let p = Path::new(file);
    // 从文件所在目录（或把 file 当目录）开始向上找。
    let mut cur = if p.is_dir() {
        Some(p.to_path_buf())
    } else {
        p.parent().map(Path::to_path_buf)
    };
    while let Some(dir) = cur {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        cur = dir.parent().map(Path::to_path_buf);
    }
    None
}

// `check_rules(file, repo?)`：调 `ocr rules check <file> [--repo <repo>]`，
// 成功时把命中规则文本放进 data。
//
// repo 解析顺序（I2）：
//   1. 调用方显式传入的非空 repo → 直接用（仓库级作用范围选定的目录）；
//   2. 否则由 file 向上回溯 git root → 用其作 `--repo`（global 作用范围的自动定位）；
//   3. 两者都无（文件不在 git 仓库内）→ 不传 `--repo`，但仍会以 cwd 定位而失败，
//      故此处直接返回带清晰中文提示的失败结果，不让 CLI 抛出 cwd 错误。
pub fn check_rules_result(file: &str, repo: Option<&str>) -> Result<OcrResult, String> {
    let explicit = repo.map(str::trim).filter(|s| !s.is_empty());
    let effective: Option<PathBuf> = match explicit {
        Some(r) => Some(PathBuf::from(r)),
        None => find_git_root(file),
    };

    let Some(root) = effective else {
        return Ok(OcrResult {
            ok: false,
            exit_code: 1,
            stdout: String::new(),
            stderr: format!(
                "无法定位 git 仓库：文件 `{file}` 不在任何 git 仓库内，且未指定仓库目录。\n\
                 请把文件放入 git 仓库，或先选择仓库目录后再验证。"
            ),
            data: None,
        });
    };

    let root_str = root.to_string_lossy().to_string();
    let mut r = run_ocr(&["rules", "check", file, "--repo", root_str.as_str()])?;
    if r.ok {
        r.data = Some(serde_json::Value::String(r.stdout.clone()));
    }
    Ok(r)
}
