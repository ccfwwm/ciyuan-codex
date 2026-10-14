//! Sub2API account operations. Secrets never cross the renderer bridge.
use std::time::Duration;

use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio::sync::Mutex;

use super::{atomic_file, paths, settings_store};

pub const DEFAULT_GATEWAY: &str = "https://code.aicodeme.xyz";
pub const GATEWAYS: [&str; 3] = [
    DEFAULT_GATEWAY,
    "https://code.aicodeme.cn",
    "https://hkcode.aicodeme.xyz",
];
const VAULT_SERVICE: &str = "io.github.ccfwwm.ciyuan-codex";
const SESSION_ENTRY: &str = "account-session";
const MAX_REPLY: usize = 4 * 1024 * 1024;
// Release admission: verified against the live Responses SSE and tool-call API.
const VERIFIED_MODELS: &[&str] = &[
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6.1-sol",
];

fn vault_service() -> String {
    paths::packaged_smoke_run_id()
        .map(|id| format!("{VAULT_SERVICE}.smoke.{id}"))
        .unwrap_or_else(|| VAULT_SERVICE.into())
}

pub fn gateway(raw: &str) -> Result<String, String> {
    if GATEWAYS.contains(&raw) {
        Ok(raw.into())
    } else {
        Err("请选择内置的服务节点。".into())
    }
}

pub fn read_secret(name: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(&vault_service(), name).map_err(|_| "无法打开系统凭据库。")?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统凭据库，请解锁凭据库后重试。".into()),
    }
}
fn write_secret(name: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(&vault_service(), name)
        .map_err(|_| "无法打开系统凭据库。")?
        .set_password(value)
        .map_err(|_| "无法保存到系统凭据库。".into())
}
fn delete_secret(name: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(&vault_service(), name).map_err(|_| "无法打开系统凭据库。")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法清除系统凭据库中的记录。".into()),
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    gateway: String,
    email: String,
    #[serde(default)]
    key_entries: Vec<String>,
    #[serde(default)]
    selected_group: Option<u64>,
    #[serde(default)]
    selected_model: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    base: String,
    email: String,
    user_id: u64,
    access_token: String,
    refresh_token: Option<String>,
    remember: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: u64,
    pub name: String,
    pub platform: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub signed_in: bool,
    pub gateway: String,
    pub email: String,
    pub balance: Option<f64>,
    pub stale: bool,
    pub groups: Vec<Group>,
    pub low_balance_threshold: f64,
    pub public_config: Value,
    pub selected_group: Option<u64>,
    pub selected_model: Option<String>,
}

struct Account {
    loaded: bool,
    preferences: Preferences,
    session: Option<Session>,
    balance: Option<f64>,
    groups: Vec<Group>,
    config: Value,
    stale: bool,
}
impl Default for Account {
    fn default() -> Self {
        let preferences = paths::data_dir()
            .and_then(|p| std::fs::read(p.join("platform.json")).ok())
            .and_then(|b| serde_json::from_slice::<Preferences>(&b).ok())
            .unwrap_or_default();
        Self {
            loaded: false,
            preferences,
            session: None,
            balance: None,
            groups: vec![],
            config: json!({}),
            stale: false,
        }
    }
}
impl Account {
    fn base(&self) -> String {
        gateway(&self.preferences.gateway).unwrap_or_else(|_| DEFAULT_GATEWAY.into())
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            signed_in: self.session.is_some(),
            gateway: self.base(),
            email: self.preferences.email.clone(),
            balance: self.balance,
            stale: self.stale,
            groups: self.groups.clone(),
            low_balance_threshold: self.config["balance_low_notify_threshold"]
                .as_f64()
                .unwrap_or(5.0),
            public_config: self.config.clone(),
            selected_group: self.preferences.selected_group,
            selected_model: self.preferences.selected_model.clone(),
        }
    }
    fn save_preferences(&self) -> Result<(), String> {
        let file = paths::data_dir()
            .ok_or("无法定位应用数据目录。")?
            .join("platform.json");
        atomic_file::write_atomic(
            &file,
            &serde_json::to_vec(&self.preferences).map_err(|_| "配置序列化失败。")?,
        )
        .map_err(|_| "无法保存账户偏好。".into())
    }
    fn load(&mut self) -> Result<(), String> {
        if !self.loaded {
            if let Some(raw) = read_secret(SESSION_ENTRY)? {
                let session: Session = serde_json::from_str(&raw)
                    .map_err(|_| "已保存的会话损坏，请清除保存信息后重新登录。")?;
                gateway(&session.base)?;
                self.preferences.gateway = session.base.clone();
                self.preferences.email = session.email.clone();
                self.session = Some(session);
            }
            self.loaded = true;
        }
        Ok(())
    }
    fn save_session(&self) -> Result<(), String> {
        if let Some(s) = &self.session {
            if s.remember {
                return write_secret(
                    SESSION_ENTRY,
                    &serde_json::to_string(s).map_err(|_| "会话序列化失败。")?,
                );
            }
        }
        delete_secret(SESSION_ENTRY)
    }
}

#[derive(Default)]
pub struct PlatformService {
    inner: Mutex<Account>,
}

fn client() -> Result<Client, String> {
    let settings = settings_store::AppSettings::load();
    let mut builder = Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(90))
        .user_agent(concat!("Ciyuan-Codex/", env!("CARGO_PKG_VERSION")));
    match settings.proxy_mode {
        settings_store::ProxyMode::Direct => builder = builder.no_proxy(),
        settings_store::ProxyMode::Custom => {
            let proxy =
                super::network::validated_custom_proxy(&settings.custom_proxy_url, "platform")
                    .map_err(|_| "代理地址无效。")?;
            builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| "代理地址无效。")?);
        }
        settings_store::ProxyMode::System => {}
    }
    builder.build().map_err(|_| "无法初始化网络连接。".into())
}

fn data(value: Value) -> Value {
    value.get("data").cloned().unwrap_or(value)
}
fn number(v: &Value, name: &str) -> Result<u64, String> {
    v[name]
        .as_u64()
        .ok_or_else(|| "平台响应缺少有效标识。".into())
}
fn text(v: &Value, name: &str) -> Result<String, String> {
    v[name]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| "平台响应不完整。".into())
}
fn api_error(status: u16, value: &Value) -> String {
    let code = value["code"]
        .as_str()
        .or(value["error"]["code"].as_str())
        .unwrap_or("");
    if value["message"].as_str() == Some("amount out of range") {
        return "充值金额不符合平台当前限制，请调整金额或打开平台查看。".into();
    }
    match (status, code) {
        (401, _) => "登录已过期或账号密码不正确，请重新登录。".into(),
        (402, _) => "余额或套餐额度不足，请充值后重试。".into(),
        (403, _) => "当前账户没有访问权限，请检查分组或平台限制。".into(),
        (429, _) => "请求过于频繁，请稍后重试。".into(),
        (_, "INVALID_VERIFY_CODE" | "VERIFICATION_CODE_INVALID" | "EMAIL_VERIFY_CODE_INVALID") => {
            "邮箱验证码无效或已过期。".into()
        }
        _ => format!("平台请求失败（HTTP {status}），请检查输入或稍后重试。"),
    }
}
async fn reply(mut response: reqwest::Response) -> Result<Value, String> {
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "平台响应中断，请重试。")?
    {
        if bytes.len() + chunk.len() > MAX_REPLY {
            return Err("平台响应超出允许大小。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        return Err(api_error(status, &value));
    }
    if value.is_null() {
        return Err("平台返回了无法识别的响应。".into());
    }
    Ok(data(value))
}
async fn public(
    base: &str,
    path: &str,
    method: Method,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut request = client()?.request(method, format!("{base}/api/v1{path}"));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "无法连接服务节点，请检查网络或切换节点。")?;
    reply(response).await
}
async fn authenticated(
    a: &mut Account,
    path: &str,
    method: Method,
    body: Option<Value>,
) -> Result<Value, String> {
    let s = a.session.clone().ok_or("请先登录词元互联账户。")?;
    let send = |token: String| {
        let method = method.clone();
        let body = body.clone();
        let base = s.base.clone();
        async move {
            let mut req = client()?
                .request(method, format!("{base}/api/v1{path}"))
                .bearer_auth(token);
            if let Some(body) = body {
                req = req.json(&body);
            }
            req.send()
                .await
                .map_err(|_| "无法连接服务节点，请检查网络或切换节点。".to_string())
        }
    };
    let mut response = send(s.access_token.clone()).await?;
    if response.status() == 401 {
        if let Some(refresh) = &s.refresh_token {
            let tokens = public(
                &s.base,
                "/auth/refresh",
                Method::POST,
                Some(json!({"refresh_token":refresh})),
            )
            .await?;
            let mut next = s.clone();
            next.access_token = text(&tokens, "access_token")?;
            next.refresh_token = tokens["refresh_token"]
                .as_str()
                .map(String::from)
                .or(next.refresh_token);
            a.session = Some(next.clone());
            a.save_session()?;
            response = send(next.access_token).await?;
        }
    }
    reply(response).await
}
fn email(raw: &str) -> Result<String, String> {
    let email = raw.trim().to_lowercase();
    if email.len() > 254 || !email.contains('@') || email.chars().any(char::is_whitespace) {
        return Err("请输入有效的邮箱地址。".into());
    }
    Ok(email)
}
fn parse_groups(value: &Value) -> Vec<Group> {
    let rows = value.as_array().or_else(|| value["items"].as_array());
    rows.into_iter()
        .flatten()
        .filter_map(|row| {
            Some(Group {
                id: row["id"].as_u64()?,
                name: row["name"].as_str()?.into(),
                platform: row["platform"].as_str().unwrap_or("").into(),
            })
        })
        .collect()
}
async fn refresh_account(a: &mut Account) -> Result<(), String> {
    let user = authenticated(a, "/auth/me", Method::GET, None).await?;
    let user = user.get("user").unwrap_or(&user);
    let expected = a.session.as_ref().ok_or("会话已改变。")?.user_id;
    if number(user, "id")? != expected {
        return Err("节点账户不一致，切换已取消。".into());
    }
    let groups = parse_groups(&authenticated(a, "/groups/available", Method::GET, None).await?);
    a.balance = user["balance"].as_f64();
    a.groups = groups;
    Ok(())
}

#[tauri::command]
pub async fn platform_snapshot(service: State<'_, PlatformService>) -> Result<Snapshot, String> {
    let mut a = service.inner.lock().await;
    a.load()?;
    let base = a.base();
    a.stale = false;
    match public(&base, "/settings/public", Method::GET, None).await {
        Ok(config) => a.config = config,
        Err(e) if a.config == json!({}) && a.session.is_none() => return Err(e),
        Err(_) => a.stale = true,
    }
    if a.session.is_some() {
        if let Err(e) = refresh_account(&mut a).await {
            a.stale = true;
            if e.starts_with("登录已过期") {
                a.session = None;
                a.balance = None;
                a.groups.clear();
                delete_secret(SESSION_ENTRY)?;
            }
        }
    }
    Ok(a.snapshot())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    gateway: String,
    email: String,
    password: String,
    remember: bool,
    verification_code: Option<String>,
}

#[tauri::command]
pub async fn platform_login(
    input: LoginInput,
    register: bool,
    service: State<'_, PlatformService>,
) -> Result<Snapshot, String> {
    let mut a = service.inner.lock().await;
    let base = gateway(&input.gateway)?;
    let email = email(&input.email)?;
    if input.password.len() < 6 || input.password.len() > 1024 {
        return Err("密码长度应为 6 到 1024 个字符。".into());
    }
    let config = public(&base, "/settings/public", Method::GET, None).await?;
    if [
        "turnstile_enabled",
        "tencent_captcha_enabled",
        "aliyun_captcha_enabled",
    ]
    .iter()
    .any(|k| config[k].as_bool() == Some(true))
    {
        return Err("平台已启用人机验证，请在平台网页完成验证。".into());
    }
    let body = if register {
        if config["registration_enabled"].as_bool() != Some(true) {
            return Err("平台暂未开放注册。".into());
        }
        if config["invitation_code_enabled"].as_bool() == Some(true) {
            return Err("平台注册需要邀请码，请使用平台网页注册。".into());
        }
        json!({"email":email,"password":input.password,"verify_code":input.verification_code.unwrap_or_default()})
    } else {
        json!({"email":email,"password":input.password})
    };
    let value = public(
        &base,
        if register {
            "/auth/register"
        } else {
            "/auth/login"
        },
        Method::POST,
        Some(body),
    )
    .await?;
    if value["requires_2fa"].as_bool() == Some(true) {
        return Err("该账户启用了二次验证，当前版本请使用未启用二次验证的专用账户。".into());
    }
    let user_id = number(&value["user"], "id")?;
    let session = Session {
        base: base.clone(),
        email: email.clone(),
        user_id,
        access_token: text(&value, "access_token")?,
        refresh_token: value["refresh_token"].as_str().map(String::from),
        remember: input.remember,
    };
    let mut candidate = Account {
        loaded: true,
        preferences: Preferences {
            gateway: base,
            email,
            key_entries: a.preferences.key_entries.clone(),
            selected_group: a.preferences.selected_group,
            selected_model: a.preferences.selected_model.clone(),
        },
        session: Some(session),
        balance: None,
        groups: vec![],
        config,
        stale: false,
    };
    refresh_account(&mut candidate).await?;
    candidate.save_session()?;
    candidate.save_preferences()?;
    *a = candidate;
    Ok(a.snapshot())
}

#[tauri::command]
pub async fn platform_select_gateway(
    base: String,
    service: State<'_, PlatformService>,
) -> Result<Snapshot, String> {
    let mut a = service.inner.lock().await;
    a.load()?;
    let base = gateway(&base)?;
    let config = public(&base, "/settings/public", Method::GET, None).await?;
    let mut next = Account {
        loaded: true,
        preferences: Preferences {
            gateway: base.clone(),
            email: a.preferences.email.clone(),
            key_entries: a.preferences.key_entries.clone(),
            selected_group: a.preferences.selected_group,
            selected_model: a.preferences.selected_model.clone(),
        },
        session: a.session.clone(),
        balance: a.balance,
        groups: a.groups.clone(),
        config,
        stale: false,
    };
    if let Some(s) = &mut next.session {
        s.base = base;
        refresh_account(&mut next).await?;
    }
    next.save_session()?;
    next.save_preferences()?;
    *a = next;
    Ok(a.snapshot())
}

#[tauri::command]
pub async fn platform_send_email(
    base: String,
    address: String,
    reset: bool,
    service: State<'_, PlatformService>,
) -> Result<Value, String> {
    let _guard = service.inner.lock().await;
    public(
        &gateway(&base)?,
        if reset {
            "/auth/forgot-password"
        } else {
            "/auth/send-verify-code"
        },
        Method::POST,
        Some(json!({"email":email(&address)?})),
    )
    .await
}

#[tauri::command]
pub async fn platform_logout(
    forget: bool,
    service: State<'_, PlatformService>,
    manager: State<'_, crate::state::ManagerState>,
) -> Result<(), String> {
    let mut a = service.inner.lock().await;
    if let Err(error) = a.load() {
        if !forget {
            return Err(error);
        }
    }
    let _op = manager
        .operations
        .begin(super::oplock::OperationKind::Update)
        .map_err(|_| "另一项操作正在进行，请稍后重试。")?;
    if super::codex_connection::status()?.backup_available {
        super::codex_connection::prepare_launch_for_manager(&manager).await?;
    }
    super::codex_connection::restore()?;
    if let Some(s) = &a.session {
        if let Some(refresh) = &s.refresh_token {
            let _ = public(
                &s.base,
                "/auth/logout",
                Method::POST,
                Some(json!({"refresh_token":refresh})),
            )
            .await;
        }
    }
    delete_secret(SESSION_ENTRY)?;
    for entry in &a.preferences.key_entries {
        delete_secret(entry)?;
    }
    a.preferences.key_entries.clear();
    a.session = None;
    a.balance = None;
    a.groups.clear();
    a.loaded = true;
    if forget {
        a.preferences.email.clear();
        a.preferences.selected_group = None;
        a.preferences.selected_model = None;
    }
    a.save_preferences()?;
    Ok(())
}

pub struct SelectedKey {
    pub entry: String,
    pub key: String,
    pub base: String,
}
async fn selected_key(a: &mut Account, group_id: u64) -> Result<SelectedKey, String> {
    if !a.groups.iter().any(|g| g.id == group_id) {
        return Err("该分组不在账户可用分组中。".into());
    }
    let s = a.session.as_ref().ok_or("请先登录。")?.clone();
    let entry = format!("key:{}:{group_id}", s.user_id);
    let name = format!("词元互联 Codex [{group_id}]");
    let mut found = None;
    for page in 1..=100 {
        let list = authenticated(
            a,
            &format!("/keys?page={page}&page_size=100&group_id={group_id}"),
            Method::GET,
            None,
        )
        .await?;
        let rows = list["items"].as_array().ok_or("API Key 列表响应无效。")?;
        found = rows
            .iter()
            .find(|v| {
                v["name"].as_str() == Some(&name)
                    && v["group_id"].as_u64() == Some(group_id)
                    && v["status"].as_str() == Some("active")
            })
            .cloned();
        if found.is_some() || rows.len() < 100 {
            break;
        }
        if page == 100 {
            return Err("API Key 列表过大，请先在平台整理后重试。".into());
        }
    }
    let value = match found {
        Some(v) => v,
        None => {
            authenticated(
                a,
                "/keys",
                Method::POST,
                Some(json!({"name":name,"group_id":group_id})),
            )
            .await?
        }
    };
    let key = text(&value, "key")?;
    if !a.preferences.key_entries.contains(&entry) {
        a.preferences.key_entries.push(entry.clone());
        a.save_preferences()?;
    }
    write_secret(&entry, &key)?;
    Ok(SelectedKey {
        entry,
        key,
        base: s.base,
    })
}
async fn catalog(key: &SelectedKey, version: &str) -> Result<Value, String> {
    let response = client()?
        .get(format!("{}/v1/models", key.base))
        .query(&[("client_version", version)])
        .bearer_auth(&key.key)
        .send()
        .await
        .map_err(|_| "模型目录读取失败，请检查网络。")?;
    let value = reply(response).await?;
    if value["models"].as_array().is_none() {
        return Err("该分组未提供 Codex 原生模型目录，请选择兼容分组。".into());
    }
    Ok(value)
}
fn models(catalog: &Value) -> Vec<Model> {
    catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["visibility"].as_str() != Some("hide"))
        .filter_map(|v| {
            let id = v["slug"].as_str()?.to_string();
            if !VERIFIED_MODELS.contains(&id.as_str()) {
                return None;
            }
            Some(Model {
                name: v["display_name"].as_str().unwrap_or(&id).into(),
                description: v["description"].as_str().unwrap_or("").into(),
                id,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn platform_models(
    group_id: u64,
    service: State<'_, PlatformService>,
    manager: State<'_, crate::state::ManagerState>,
) -> Result<Vec<Model>, String> {
    let mut a = service.inner.lock().await;
    a.load()?;
    let version = super::codex_connection::preflight(&manager)?;
    let key = selected_key(&mut a, group_id).await?;
    Ok(models(&catalog(&key, &version).await?))
}

#[derive(Default)]
struct Probe {
    completed: bool,
    tool: bool,
}
impl Probe {
    fn event(&mut self, raw: &str) -> Result<(), String> {
        let Ok(v) = serde_json::from_str::<Value>(raw) else {
            return Ok(());
        };
        match v["type"].as_str().unwrap_or("") {
            "response.failed" | "error" | "response.incomplete" => {
                return Err("模型验证失败：响应未完成。".into())
            }
            "response.completed" => {
                self.completed = v["response"]["status"].as_str() == Some("completed");
                if let Some(rows) = v["response"]["output"].as_array() {
                    for row in rows {
                        self.tool |= valid_tool(row);
                    }
                }
            }
            "response.output_item.done" => self.tool |= valid_tool(&v["item"]),
            _ => {}
        }
        Ok(())
    }
}
fn valid_tool(item: &Value) -> bool {
    item["type"].as_str() == Some("function_call")
        && item["name"].as_str() == Some("ciyuan_probe")
        && item["call_id"].as_str().is_some_and(|s| !s.is_empty())
        && item["arguments"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .is_some_and(|v| v["message"].as_str() == Some("ok"))
}
async fn validate(key: &SelectedKey, model: &str) -> Result<(), String> {
    let body = json!({"model":model,"input":"Call ciyuan_probe with message ok.","stream":true,"max_output_tokens":256,
        "tools":[{"type":"function","name":"ciyuan_probe","description":"Connectivity test","parameters":{"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false},"strict":true}],"tool_choice":"required"});
    let mut response = client()?
        .post(format!("{}/v1/responses", key.base))
        .bearer_auth(&key.key)
        .json(&body)
        .send()
        .await
        .map_err(|_| "模型验证无法连接，请检查网络。")?;
    if !response.status().is_success() {
        reply(response).await?;
        return Err("模型验证失败。".into());
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.starts_with("text/event-stream"))
    {
        return Err("模型没有返回 Responses 流式响应。".into());
    }
    let mut pending = Vec::new();
    let mut total = 0;
    let mut probe = Probe::default();
    while let Some(chunk) = response.chunk().await.map_err(|_| "模型流式响应中断。")? {
        total += chunk.len();
        if total > MAX_REPLY {
            return Err("模型验证响应过大。".into());
        }
        pending.extend_from_slice(&chunk);
        while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
            let line = String::from_utf8(pending.drain(..=pos).collect())
                .map_err(|_| "模型流式响应编码无效。")?;
            if let Some(data) = line.trim_end().strip_prefix("data:") {
                probe.event(data.trim_start())?;
            }
        }
    }
    if probe.completed && probe.tool {
        Ok(())
    } else {
        Err("模型未通过流式工具调用验证，请选择其他兼容模型。".into())
    }
}

#[tauri::command]
pub async fn platform_apply(
    group_id: u64,
    model_id: String,
    service: State<'_, PlatformService>,
    manager: State<'_, crate::state::ManagerState>,
) -> Result<super::codex_connection::Connection, String> {
    let mut a = service.inner.lock().await;
    a.load()?;
    let _op = manager
        .operations
        .begin(super::oplock::OperationKind::Update)
        .map_err(|_| "另一项操作正在进行，请稍后重试。")?;
    let version = super::codex_connection::preflight(&manager)?;
    let key = selected_key(&mut a, group_id).await?;
    let mut catalog = catalog(&key, &version).await?;
    if !models(&catalog).iter().any(|m| m.id == model_id) {
        return Err("所选模型不在当前分组目录中。".into());
    }
    validate(&key, &model_id).await?;
    if let Some(rows) = catalog["models"].as_array_mut() {
        rows.retain(|row| {
            row["slug"]
                .as_str()
                .is_some_and(|slug| VERIFIED_MODELS.contains(&slug))
        });
    }
    let connection = super::codex_connection::apply(&key.base, &key.entry, &model_id, &catalog)?;
    a.preferences.selected_group = Some(group_id);
    a.preferences.selected_model = Some(model_id);
    a.save_preferences()?;
    Ok(connection)
}

#[tauri::command]
pub async fn platform_orders(
    page: u32,
    service: State<'_, PlatformService>,
) -> Result<Value, String> {
    let mut a = service.inner.lock().await;
    if !(1..=10000).contains(&page) {
        return Err("页码无效。".into());
    }
    authenticated(
        &mut a,
        &format!("/payment/orders/my?page={page}&page_size=10"),
        Method::GET,
        None,
    )
    .await
}
#[tauri::command]
pub async fn platform_checkout(service: State<'_, PlatformService>) -> Result<Value, String> {
    authenticated(
        &mut *service.inner.lock().await,
        "/payment/checkout-info",
        Method::GET,
        None,
    )
    .await
}
#[tauri::command]
pub async fn platform_create_order(
    amount: f64,
    payment_type: String,
    service: State<'_, PlatformService>,
) -> Result<Value, String> {
    let mut a = service.inner.lock().await;
    let config = authenticated(&mut a, "/payment/checkout-info", Method::GET, None).await?;
    let method = &config["methods"][&payment_type];
    if config["balance_disabled"].as_bool() == Some(true)
        || !method.is_object()
        || method["available"].as_bool() == Some(false)
    {
        return Err("当前充值渠道不可用。".into());
    }
    let min = method["single_min"]
        .as_f64()
        .unwrap_or(0.0)
        .max(config["global_min"].as_f64().unwrap_or(0.0));
    let max = [method["single_max"].as_f64(), config["global_max"].as_f64()]
        .into_iter()
        .flatten()
        .filter(|v| *v > 0.0)
        .fold(f64::INFINITY, f64::min);
    if !amount.is_finite() || amount <= 0.0 || amount < min || (max > 0.0 && amount > max) {
        return Err("充值金额不符合当前渠道限制。".into());
    }
    authenticated(&mut a,"/payment/orders",Method::POST,Some(json!({"amount":amount,"payment_type":payment_type,"order_type":"balance","payment_source":"hosted_redirect","is_mobile":false}))).await
}
#[tauri::command]
pub async fn platform_order(
    order_id: u64,
    service: State<'_, PlatformService>,
) -> Result<Value, String> {
    authenticated(
        &mut *service.inner.lock().await,
        &format!("/payment/orders/{order_id}"),
        Method::GET,
        None,
    )
    .await
}

/// Developer smoke uses stdin and an isolated credential namespace; never bundled as a separate binary.
#[cfg(debug_assertions)]
pub fn smoke_mode() -> Option<i32> {
    let mode = std::env::args().nth(1)?;
    if mode != "--ciyuan-smoke-connect" && mode != "--ciyuan-smoke-clean" {
        return None;
    }
    let result = (|| -> Result<(), String> {
        if paths::packaged_smoke_run_id().is_none() {
            return Err("smoke isolation required".into());
        }
        let root = std::env::var_os("CODEX_HOME")
            .map(std::path::PathBuf::from)
            .ok_or("isolated CODEX_HOME required")?;
        let data_dir = paths::data_dir().ok_or("isolated data directory required")?;
        if root
            .canonicalize()
            .map_err(|_| "smoke Codex directory missing")?
            != data_dir.join("codex")
        {
            return Err("CODEX_HOME must be the smoke data directory child".into());
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "runtime failed")?;
        runtime.block_on(async {
            let mut a = Account::default();
            if mode == "--ciyuan-smoke-clean" {
                super::codex_connection::restore()?;
                a.load()?;
                for entry in &a.preferences.key_entries { delete_secret(entry)?; }
                delete_secret(SESSION_ENTRY)?;
                return Ok(());
            }
            use std::io::Read;
            let mut raw = String::new(); std::io::stdin().take(32768).read_to_string(&mut raw).map_err(|_| "stdin failed")?;
            let session: Session = serde_json::from_str(&raw).map_err(|_| "invalid smoke session")?;
            gateway(&session.base)?;
            a.preferences.gateway = session.base.clone(); a.preferences.email = session.email.clone();
            a.session = Some(session); a.loaded = true;
            a.save_session()?;
            let service = PlatformService { inner: Mutex::new(a) };
            let mut a = service.inner.lock().await;
            refresh_account(&mut a).await?;
            let key = selected_key(&mut a, 3).await?;
            let catalog = catalog(&key, "0.156.1").await?;
            validate(&key, "gpt-6.1-sol").await?;
            let config = super::codex_connection::apply(&key.base, &key.entry, "gpt-6.1-sol", &catalog)?;
            if !config.connected { return Err("smoke configuration not connected".into()); }
            // Repeat apply exercises the existing journal path.
            super::codex_connection::apply(&key.base, &key.entry, "gpt-6.1-sol", &catalog)?;
            println!("{}", json!({"connected":true,"group":3,"model":"gpt-6.1-sol","keyEntry":key.entry,"models":models(&catalog).len(),"configuration":root.join("config.toml")}));
            Ok::<(), String>(())
        })
    })();
    if let Err(error) = &result {
        eprintln!("{error}");
    }
    Some(if result.is_ok() { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricts_credentials_to_known_origins() {
        assert!(gateway(DEFAULT_GATEWAY).is_ok());
        for base in [
            "https://code.aicodeme.xyz.evil.test",
            "http://code.aicodeme.xyz",
            "https://user:pass@code.aicodeme.xyz",
        ] {
            assert!(gateway(base).is_err());
        }
    }
    #[test]
    fn validates_completed_tool_call_not_just_sse_headers() {
        let mut p = Probe::default();
        p.event(r#"{"type":"response.completed","response":{"status":"completed","output":[]}}"#)
            .unwrap();
        assert!(!p.tool);
        p.event(r#"{"type":"response.output_item.done","item":{"type":"function_call","name":"ciyuan_probe","call_id":"fixture","arguments":"{\"message\":\"ok\"}"}}"#).unwrap();
        assert!(p.tool && p.completed);
        assert!(p.event(r#"{"type":"response.incomplete"}"#).is_err());
    }
    #[test]
    fn snapshot_does_not_contain_credentials() {
        let a = Account {
            loaded: true,
            preferences: Preferences::default(),
            session: Some(Session {
                base: DEFAULT_GATEWAY.into(),
                email: "test@example.test".into(),
                user_id: 1,
                access_token: "PRIVATE_TOKEN".into(),
                refresh_token: Some("PRIVATE_REFRESH".into()),
                remember: true,
            }),
            balance: None,
            groups: vec![],
            config: json!({}),
            stale: false,
        };
        let encoded = serde_json::to_string(&a.snapshot()).unwrap();
        assert!(!encoded.contains("PRIVATE"));
    }
}
