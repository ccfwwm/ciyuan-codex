//! Only owned TOML fields are changed/restored. The original auth.json is untouched.
use super::{atomic_file, paths};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use toml_edit::{value, DocumentMut, Item, Table};

const PROVIDER: &str = "ciyuan_sub2api";
const FIELDS: [&str; 3] = ["model", "model_provider", "model_catalog_json"];

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub connected: bool,
    pub model: Option<String>,
    pub gateway: Option<String>,
    pub backup_available: bool,
}

#[derive(Serialize, Deserialize)]
struct Journal {
    config_path: PathBuf,
    original: String,
    applied: String,
    pending: Option<String>,
}

fn journal_path() -> Result<PathBuf, String> {
    Ok(paths::data_dir()
        .ok_or("无法定位应用数据目录。")?
        .join("codex-connection.json"))
}
fn config_path() -> Result<PathBuf, String> {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| directories::BaseDirs::new().map(|d| d.home_dir().join(".codex")))
        .ok_or("无法定位 Codex 用户目录。")?;
    if !root.is_absolute() {
        return Err("CODEX_HOME 必须是绝对路径。".into());
    }
    Ok(root.join("config.toml"))
}
fn read_config(path: &Path) -> Result<String, String> {
    read_config_inner(
        path,
        read_journal()?.is_some_and(|journal| journal.config_path == path),
    )
}
fn read_config_inner(path: &Path, recover: bool) -> Result<String, String> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Codex 配置为符号链接，请先确认配置位置。".into());
    }
    match fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if recover {
                let backup = atomic_file::backup_path(path);
                if backup.exists() {
                    if fs::symlink_metadata(&backup).is_ok_and(|m| m.file_type().is_symlink()) {
                        return Err("Codex 配置备份为符号链接，恢复已暂停。".into());
                    }
                    let raw =
                        fs::read_to_string(backup).map_err(|_| "无法读取 Codex 配置备份。")?;
                    parse(&raw)?;
                    private_write(path, raw.as_bytes())?;
                    return Ok(raw);
                }
            }
            Ok(String::new())
        }
        Err(_) => Err("无法读取 Codex 配置。".into()),
    }
}
fn parse(raw: &str) -> Result<DocumentMut, String> {
    raw.parse()
        .map_err(|_| "Codex 配置不是有效 TOML，请先修复原配置。".into())
}
fn owned_match(a: &DocumentMut, b: &DocumentMut) -> bool {
    FIELDS
        .iter()
        .all(|key| a.get(key).map(Item::to_string) == b.get(key).map(Item::to_string))
        && a.get("model_providers")
            .and_then(|v| v.get(PROVIDER))
            .map(Item::to_string)
            == b.get("model_providers")
                .and_then(|v| v.get(PROVIDER))
                .map(Item::to_string)
}
fn read_journal() -> Result<Option<Journal>, String> {
    let path = journal_path()?;
    read_journal_at(&path)
}
fn read_journal_at(path: &Path) -> Result<Option<Journal>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "接入备份损坏，请保留备份后联系支持。".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            match fs::read(atomic_file::backup_path(path)) {
                Ok(bytes) => {
                    let journal = serde_json::from_slice(&bytes)
                        .map_err(|_| "接入备份损坏，请保留备份后联系支持。")?;
                    private_write(path, &bytes)?;
                    Ok(Some(journal))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(_) => Err("无法读取接入备份。".into()),
            }
        }
        Err(_) => Err("无法读取接入备份。".into()),
    }
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_file::write_atomic(path, bytes)
        .map_err(|_| "无法写入配置，请检查文件权限。".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法保护配置文件权限。".to_string())?;
    }
    Ok(())
}
fn save_journal(j: &Journal) -> Result<(), String> {
    private_write(
        &journal_path()?,
        &serde_json::to_vec(j).map_err(|_| "备份序列化失败。")?,
    )
}
fn check_journal(j: &Journal, path: &Path, current: &DocumentMut) -> Result<(), String> {
    if j.config_path != path {
        return Err("Codex 用户目录已改变，请先恢复原目录中的配置。".into());
    }
    if owned_match(current, &parse(&j.applied)?)
        || j.pending
            .as_ref()
            .is_some_and(|p| parse(p).is_ok_and(|d| owned_match(current, &d)))
    {
        Ok(())
    } else {
        Err("接入字段已被其他程序修改，已保留当前配置，请手动核对后重试。".into())
    }
}
pub fn status() -> Result<Connection, String> {
    let doc = parse(&read_config(&config_path()?)?)?;
    let connected = doc.get("model_provider").and_then(Item::as_str) == Some(PROVIDER);
    Ok(Connection {
        connected,
        model: doc.get("model").and_then(Item::as_str).map(String::from),
        gateway: doc
            .get("model_providers")
            .and_then(|v| v.get(PROVIDER))
            .and_then(|v| v.get("base_url"))
            .and_then(Item::as_str)
            .map(String::from),
        backup_available: read_journal()?.is_some(),
    })
}
fn connect_document(
    mut doc: DocumentMut,
    base: &str,
    entry: &str,
    model: &str,
    catalog_path: &Path,
    executable: &Path,
) -> Result<DocumentMut, String> {
    if let Some(profile) = doc.get("profile").and_then(Item::as_str) {
        if doc
            .get("profiles")
            .and_then(|p| p.get(profile))
            .is_some_and(|p| FIELDS.iter().any(|field| p.get(field).is_some()))
        {
            return Err(
                "当前 Codex 配置档覆盖了模型设置，请先在 Codex 中取消该配置档的模型覆盖后接入。"
                    .into(),
            );
        }
    }
    // Top-level values stay ahead of TOML table headers; toml_edit handles placement.
    doc["model"] = value(model);
    doc["model_provider"] = value(PROVIDER);
    doc["model_catalog_json"] = value(catalog_path.to_string_lossy().as_ref());
    if doc.get("model_providers").is_none() {
        doc["model_providers"] = Item::Table(Table::new());
    }
    let providers = doc["model_providers"]
        .as_table_mut()
        .ok_or("model_providers 必须为 TOML 表。")?;
    let mut provider = Table::new();
    provider["name"] = value("词元互联");
    provider["base_url"] = value(format!("{base}/v1"));
    provider["wire_api"] = value("responses");
    let mut auth = Table::new();
    auth["command"] = value(executable.to_string_lossy().as_ref());
    let mut args = toml_edit::Array::new();
    args.push("--ciyuan-print-key");
    args.push(entry);
    auth["args"] = value(args);
    auth["timeout_ms"] = value(30000i64);
    auth["refresh_interval_ms"] = value(300000i64);
    provider["auth"] = Item::Table(auth);
    providers[PROVIDER] = Item::Table(provider);
    Ok(doc)
}
pub fn apply(base: &str, entry: &str, model: &str, catalog: &Value) -> Result<Connection, String> {
    super::platform::gateway(base)?;
    let path = config_path()?;
    let current = read_config(&path)?;
    let doc = parse(&current)?;
    let mut journal = if let Some(j) = read_journal()? {
        check_journal(&j, &path, &doc)?;
        j
    } else {
        if doc
            .get("model_providers")
            .and_then(|v| v.get(PROVIDER))
            .is_some()
        {
            return Err("该 provider 已存在且不属于当前接入备份，已保留配置。".into());
        }
        Journal {
            config_path: path.clone(),
            original: current.clone(),
            applied: current,
            pending: None,
        }
    };
    let catalog_bytes = serde_json::to_vec(catalog).map_err(|_| "模型目录序列化失败。")?;
    let catalog_path = paths::data_dir()
        .ok_or("无法定位应用数据目录。")?
        .join(catalog_file_name(base, entry, &catalog_bytes));
    let executable = std::env::current_exe().map_err(|_| "无法定位管理器凭据程序。")?;
    let next = connect_document(doc, base, entry, model, &catalog_path, &executable)?.to_string();
    journal.pending = Some(next.clone());
    save_journal(&journal)?;
    // Content-addressed catalogs leave the previous connection intact if the
    // subsequent configuration replacement fails.
    private_write(&catalog_path, &catalog_bytes)?;
    private_write(&path, next.as_bytes())?;
    journal.applied = next;
    journal.pending = None;
    save_journal(&journal)?;
    status()
}
fn restore_document(
    mut current: DocumentMut,
    original: &DocumentMut,
) -> Result<DocumentMut, String> {
    for key in FIELDS {
        if let Some(item) = original.get(key) {
            current[key] = item.clone();
        } else {
            current.remove(key);
        }
    }
    if let Some(providers) = current.get_mut("model_providers") {
        let table = providers
            .as_table_mut()
            .ok_or("model_providers 必须为 TOML 表。")?;
        if let Some(item) = original
            .get("model_providers")
            .and_then(|p| p.get(PROVIDER))
        {
            table[PROVIDER] = item.clone();
        } else {
            table.remove(PROVIDER);
        }
        if table.is_empty() && original.get("model_providers").is_none() {
            current.remove("model_providers");
        }
    }
    Ok(current)
}
pub fn restore() -> Result<Connection, String> {
    if let Some(journal) = read_journal()? {
        let path = config_path()?;
        if journal.config_path != path {
            return Err("Codex 用户目录已改变，请先恢复原目录中的配置。".into());
        }
        let current = parse(&read_config(&path)?)?;
        let original = parse(&journal.original)?;
        if !owned_match(&current, &original) {
            check_journal(&journal, &path, &current)?;
            let next = restore_document(current, &original)?.to_string();
            private_write(&path, next.as_bytes())?;
        }
        let path = journal_path()?;
        match fs::remove_file(atomic_file::backup_path(&path)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("配置已恢复，但清除接入备份失败。".into()),
        }
        fs::remove_file(path).map_err(|_| "配置已恢复，但清除接入备份失败。")?;
    }
    status()
}

fn catalog_file_name(base: &str, entry: &str, bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(base.as_bytes());
    hash.update([0]);
    hash.update(entry.as_bytes());
    hash.update([0]);
    hash.update(bytes);
    let digest = hash.finalize();
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("codex-models-{hex}.json")
}

fn current_settings(manager: &crate::state::ManagerState) -> crate::domain::settings::AppSettings {
    #[cfg(target_os = "windows")]
    {
        crate::commands::windows_domain_settings_for_persisted(manager)
    }
    #[cfg(not(target_os = "windows"))]
    {
        manager.settings.clone()
    }
}

fn supported_version(raw: &str) -> Option<String> {
    let version = raw
        .split_whitespace()
        .find(|s| s.as_bytes().first().is_some_and(u8::is_ascii_digit))?;
    let mut parts = version.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    let patch = parts.next()?.split('-').next()?.parse::<u32>().ok()?;
    // Verified against the released 0.156.1 schema; older builds are not assumed compatible.
    if (major, minor, patch) >= (0, 156, 1) {
        Some(version.into())
    } else {
        None
    }
}
pub fn preflight(manager: &crate::state::ManagerState) -> Result<String, String> {
    let settings = current_settings(manager);
    let _ = &settings;
    #[cfg(target_os = "windows")]
    let root = super::win_update::win_install_status(&settings)
        .installed
        .map(|i| PathBuf::from(i.path));
    #[cfg(target_os = "macos")]
    let root = super::mac_update::mac_install_status()
        .installed
        .map(|i| PathBuf::from(i.path));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let root: Option<PathBuf> = None;
    let root = root.ok_or("请先在首页安装或选择已安装的 Codex。")?;
    let candidates = if cfg!(target_os = "windows") {
        vec![
            root.join("resources/codex.exe"),
            root.join("resources/bin/codex.exe"),
            root.join("app/resources/codex.exe"),
        ]
    } else {
        vec![
            root.join("Contents/Resources/codex"),
            root.join("Contents/Resources/bin/codex"),
        ]
    };
    let exe = candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or("未找到 Codex 内置命令引擎，请在首页更新 Codex 后重试。")?;
    let mut command = Command::new(exe);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "无法检查 Codex 引擎版本。")?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child
            .try_wait()
            .map_err(|_| "无法检查 Codex 引擎版本。")?
            .is_some()
        {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Codex 引擎检查超时，请更新后重试。".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "无法检查 Codex 引擎版本。")?;
    if !output.status.success() {
        return Err("无法检查 Codex 引擎版本。".into());
    }
    supported_version(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| "Codex 引擎版本过旧，请更新至 0.156.1 或更高版本后接入。".into())
}

#[tauri::command]
pub fn codex_connection_status() -> Result<Connection, String> {
    status()
}
#[tauri::command]
pub fn codex_connection_restore(
    manager: tauri::State<'_, crate::state::ManagerState>,
) -> Result<Connection, String> {
    let _op = manager
        .operations
        .begin(super::oplock::OperationKind::Update)
        .map_err(|_| "另一项操作正在进行，请稍后重试。")?;
    restore()
}

#[tauri::command]
pub async fn codex_connection_prepare_launch(
    manager: tauri::State<'_, crate::state::ManagerState>,
) -> Result<(), String> {
    let _op = manager
        .operations
        .begin(super::oplock::OperationKind::Update)
        .map_err(|_| "另一项操作正在进行，请稍后重试。")?;
    prepare_launch_for_manager(&manager).await
}

/// Stop the running Codex process and wait for it to persist its in-memory
/// configuration before a caller mutates the connection-owned fields.
pub async fn prepare_launch_for_manager(
    manager: &crate::state::ManagerState,
) -> Result<(), String> {
    let settings = current_settings(manager);
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            if let Some(installed) = super::win_update::win_install_status(&settings).installed {
                if installed.source == "msix" {
                    codex_win_engine::close_msix_codex_processes(30)
                        .map_err(|_| "Codex 未退出，请保存工作并关闭 Codex 后重试。")?;
                } else {
                    codex_win_engine::close_codex_gracefully_for_root(
                        30,
                        Path::new(&installed.path),
                    )
                    .map_err(|_| "Codex 未退出，请保存工作并关闭 Codex 后重试。")?;
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            if let Some(installed) = super::mac_update::mac_install_status().installed {
                codex_mac_engine::quit_codex_at(Path::new(&installed.path), 30)
                    .map_err(|_| "Codex 未退出，请保存工作并关闭 Codex 后重试。")?;
            }
        }
        let _ = settings;
        // Codex writes its in-memory config during shutdown. Match the theme
        // integration's settling interval before the next read/write.
        std::thread::sleep(Duration::from_secs(2));
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "Codex 退出检查失败。".to_string())?
}

/// Invoked before Tauri/logging/single-instance initialization, with stdout piped to Codex.
pub fn credential_mode() -> Option<i32> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("--ciyuan-print-key") {
        return None;
    }
    let result = (|| {
        let entry = args.get(1).filter(|_| args.len() == 2).ok_or(())?;
        let parts: Vec<_> = entry.split(':').collect();
        if parts.len() != 3
            || parts[0] != "key"
            || parts[1..].iter().any(|p| p.parse::<u64>().is_err())
        {
            return Err(());
        }
        let secret = super::platform::read_secret(entry)
            .map_err(|_| ())?
            .filter(|s| !s.is_empty())
            .ok_or(())?;
        use std::io::Write;
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(secret.as_bytes()).map_err(|_| ())?;
        stdout.flush().map_err(|_| ())?;
        Ok(())
    })();
    Some(if result.is_ok() { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_paths_preserve_the_previous_connection_on_failed_commit() {
        let a = catalog_file_name("https://code.aicodeme.xyz", "key:1:3", b"group-a");
        assert_eq!(
            a,
            catalog_file_name("https://code.aicodeme.xyz", "key:1:3", b"group-a")
        );
        assert_ne!(
            a,
            catalog_file_name("https://code.aicodeme.xyz", "key:1:4", b"group-b")
        );
        assert_ne!(
            a,
            catalog_file_name("https://code.aicodeme.xyz", "key:1:3", b"updated-a")
        );
    }
    #[test]
    fn recovers_the_journal_and_config_after_interrupted_replacement() {
        let root = std::env::temp_dir().join(format!("ciyuan-recovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let journal = root.join("journal.json");
        let config = root.join("config.toml");
        let raw = "model='original'\n";
        let entry = Journal {
            config_path: config.clone(),
            original: raw.into(),
            applied: raw.into(),
            pending: None,
        };
        private_write(&journal, &serde_json::to_vec(&entry).unwrap()).unwrap();
        fs::rename(&journal, atomic_file::backup_path(&journal)).unwrap();
        assert_eq!(read_journal_at(&journal).unwrap().unwrap().original, raw);
        assert!(journal.exists());
        private_write(&config, raw.as_bytes()).unwrap();
        fs::rename(&config, atomic_file::backup_path(&config)).unwrap();
        assert_eq!(read_config_inner(&config, true).unwrap(), raw);
        assert_eq!(fs::read_to_string(&config).unwrap(), raw);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn refuses_an_active_profile_that_overrides_the_selected_model() {
        let doc = parse("profile='other'\n[profiles.other]\nmodel_provider='openai'\n").unwrap();
        assert!(connect_document(
            doc,
            super::super::platform::DEFAULT_GATEWAY,
            "key:1:3",
            "fixture",
            Path::new("/models.json"),
            Path::new("/manager")
        )
        .is_err());
    }
    #[test]
    fn merges_and_restores_owned_fields_without_losing_user_changes() {
        let original=parse("# original\nmodel = 'old'\n[projects.test]\ntrust_level = 'trusted'\n[mcp_servers.docs]\ncommand = 'docs-server'\n").unwrap();
        let mut applied = connect_document(
            original.clone(),
            super::super::platform::DEFAULT_GATEWAY,
            "key:1:2",
            "fixture",
            Path::new("/models.json"),
            Path::new("/manager"),
        )
        .unwrap();
        assert_eq!(applied["model"].as_str(), Some("fixture"));
        assert!(applied["model_providers"][PROVIDER]
            .get("experimental_bearer_token")
            .is_none());
        applied["projects"]["second"]["trust_level"] = value("trusted");
        let restored = restore_document(applied, &original).unwrap();
        assert_eq!(restored["model"].as_str(), Some("old"));
        assert_eq!(
            restored["mcp_servers"]["docs"]["command"].as_str(),
            Some("docs-server")
        );
        assert_eq!(
            restored["projects"]["second"]["trust_level"].as_str(),
            Some("trusted")
        );
        assert!(restored.get("model_providers").is_none());
        assert!(restored.to_string().starts_with("# original"));
    }
    #[test]
    fn detects_external_changes_only_in_owned_fields() {
        let a = parse("model='one'\n[projects.test]\ntrust_level='trusted'\n").unwrap();
        let mut b = a.clone();
        b["projects"]["test"]["trust_level"] = value("untrusted");
        assert!(owned_match(&a, &b));
        b["model"] = value("two");
        assert!(!owned_match(&a, &b));
    }
    #[test]
    fn refuses_unverified_old_engine_versions() {
        assert!(supported_version("codex-cli 0.155.0").is_none());
        assert_eq!(
            supported_version("codex-cli 0.156.1"),
            Some("0.156.1".into())
        );
    }
}
