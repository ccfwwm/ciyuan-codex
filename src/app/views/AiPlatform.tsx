import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { confirm } from "@tauri-apps/plugin-dialog";
import { Icon } from "../icons";
import { NavBar } from "../components";
import { useI18n } from "../i18n";
import { acquireNavLock } from "../navLock";
import { managerApi } from "../../services/managerApi";
import { currentPlatform } from "../platform";
import { gateways, platformApi, safePaymentUrl, type PlatformSnapshot, type PlatformModel,
  type CodexConnection, type Checkout, type Orders, type PaymentOrder } from "../../services/platformApi";
import "./AiPlatform.css";

const zh = {
  title: "AI 平台", eyebrow: "词元互联 · 开箱即用", heading: "连接模型，开始创造。", intro: "一个账户，三条线路。登录后即可为 Codex 选择模型。",
  gateway: "服务节点", gatewayNote: "三条线路共用账号、余额与订单", account: "账户", models: "模型连接", recharge: "充值与订单",
  login: "登录", register: "注册", forgot: "找回密码", email: "邮箱", password: "密码", code: "邮箱验证码", send: "发送验证码",
  remember: "记住登录", remembered: "登录状态保存在系统凭据库，密码不会长期保存。", submit: "登录并连接", registerSubmit: "创建账户",
  reset: "发送重置邮件", resetHint: "重置邮件已发送。请通过邮件链接设置新密码，然后返回登录。", registered: "账户已创建并登录。",
  welcome: "账户已连接", balance: "可用余额", low: "余额较低，建议及时充值", stale: "当前为缓存数据，请刷新或切换节点。", refresh: "刷新账户",
  logout: "退出并断开", logoutConfirm: "将关闭 Codex、恢复原配置并清除登录凭据。请先保存当前工作。", forget: "清除保存信息", usage: "查看使用记录", portal: "打开平台", loginHint: "登录后自动同步账户与可用分组。",
  group: "选择分组", model: "选择模型", sync: "同步模型", syncHint: "选择分组后同步目录，为该分组准备独立 API Key。", noModels: "请先同步兼容模型目录",
  apply: "验证并应用", applyLaunch: "验证、应用并启动", validating: "正在验证流式输出与工具调用…", probeNote: "首次应用会发送一条小型工具调用测试，按平台正常计费。",
  connected: "已应用到 Codex", disconnected: "尚未接入", restore: "恢复原配置", applied: "连接已保存。新启动的 Codex 将使用所选节点与模型。", restored: "已恢复接入前的配置。",
  launchConfirm: "将关闭并重新启动 Codex，以加载新配置。请先保存当前工作。", launch: "启动已配置的 Codex", started: "Codex 已启动。",
  step1: "登录账户", step2: "选择模型", step3: "一键开始", secure: "系统凭据保护", preserved: "原有项目与 MCP 配置保留",
  amount: "充值金额", method: "支付方式", minimum: "最低", maximum: "最高", fee: "手续费", create: "生成支付订单", creating: "正在创建订单…",
  pay: "打开支付页面", scan: "使用对应支付 App 扫码", credited: "到账额度", paidAmount: "支付金额", orders: "我的订单", orderNumber: "订单号",
  emptyOrders: "还没有充值订单", emptyPayment: "创建订单后，在这里扫码或打开支付页面", previous: "上一页", next: "下一页", noPayment: "平台当前未开放余额充值",
  paymentNote: "到账以平台订单状态为准，应用会自动刷新待支付订单。", updated: "已刷新", busy: "正在处理…", backLogin: "返回登录", noAccount: "还没有账户？",
  network: "加载失败，请检查网络后重试。", select: "请选择", chooseNode: "选择线路", alipay: "支付宝", wxpay: "微信支付", page: "页", activeOrder: "当前订单", resume: "继续支付",
};
const en: typeof zh = {
  title: "AI Platform", eyebrow: "CIYUAN · READY TO CREATE", heading: "Connect your model. Make something.", intro: "One account, three routes. Sign in and choose a model for Codex.",
  gateway: "Service route", gatewayNote: "Shared account, balance and orders", account: "Account", models: "Model connection", recharge: "Payments & orders",
  login: "Sign in", register: "Sign up", forgot: "Reset password", email: "Email", password: "Password", code: "Email code", send: "Send code",
  remember: "Remember sign-in", remembered: "Your session is kept in the system credential vault. Your password is not saved.", submit: "Sign in & connect", registerSubmit: "Create account",
  reset: "Send reset email", resetHint: "Reset email sent. Set your password using the email link, then return to sign in.", registered: "Account created and signed in.",
  welcome: "Account connected", balance: "Available balance", low: "Balance is low. Consider adding credit.", stale: "Showing cached data. Refresh or change routes.", refresh: "Refresh account",
  logout: "Sign out & disconnect", logoutConfirm: "Codex will close, its previous configuration will be restored, and saved credentials will be cleared. Save your work first.", forget: "Forget saved account", usage: "View usage", portal: "Open platform", loginHint: "Sign in to sync your account and available groups.",
  group: "Group", model: "Model", sync: "Sync models", syncHint: "Sync a group to prepare its dedicated API key and model catalog.", noModels: "Sync a compatible model catalog first",
  apply: "Verify & apply", applyLaunch: "Verify, apply & launch", validating: "Verifying streaming and tool calls…", probeNote: "Applying runs one small tool-call test, billed normally by the platform.",
  connected: "Applied to Codex", disconnected: "Not connected yet", restore: "Restore previous configuration", applied: "Connection saved. Restart Codex to use the selected route and model.", restored: "Previous configuration restored.",
  launchConfirm: "Codex will close and restart to load the new configuration. Save your work first.", launch: "Launch configured Codex", started: "Codex launched.",
  step1: "Sign in", step2: "Choose model", step3: "Start creating", secure: "System credential protection", preserved: "Projects and MCP settings preserved",
  amount: "Recharge amount", method: "Payment method", minimum: "Minimum", maximum: "Maximum", fee: "Fee", create: "Create payment order", creating: "Creating order…",
  pay: "Open payment page", scan: "Scan with the matching payment app", credited: "Credit added", paidAmount: "Payment amount", orders: "My orders", orderNumber: "Order number",
  emptyOrders: "No payment orders yet", emptyPayment: "Create an order to scan or open its payment page", previous: "Previous", next: "Next", noPayment: "Balance recharge is unavailable",
  paymentNote: "The platform confirms payment and credit. Pending orders refresh automatically.", updated: "Updated", busy: "Working…", backLogin: "Back to sign in", noAccount: "New here?",
  network: "Could not load. Check your connection and retry.", select: "Select", chooseNode: "Choose a route", alipay: "Alipay", wxpay: "WeChat Pay", page: "Page", activeOrder: "Current order", resume: "Resume payment",
};
const terminal = new Set(["COMPLETED", "CANCELLED", "EXPIRED", "FAILED", "REFUNDED"]);
const labels: Record<string, [string, string]> = { PENDING: ["待支付", "Pending"], PAID: ["已支付", "Paid"], RECHARGING: ["正在到账", "Adding credit"],
  COMPLETED: ["已完成", "Completed"], CANCELLED: ["已取消", "Cancelled"], EXPIRED: ["已过期", "Expired"], FAILED: ["失败", "Failed"], REFUNDED: ["已退款", "Refunded"] };
function errorText(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
function money(value?: number, currency = "USD") {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: value > 0 && value < .01 ? 6 : 2 }).format(value); }
  catch { return `${value.toFixed(2)} ${currency}`; }
}

export function AiPlatform({ onBack }: { onBack: () => void }) {
  const { lang } = useI18n(); const chinese = lang.startsWith("zh"); const c = chinese ? zh : en;
  const [snapshot, setSnapshot] = useState<PlatformSnapshot>(); const [connection, setConnection] = useState<CodexConnection>();
  const [tab, setTab] = useState<"account" | "models" | "recharge">("account");
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true); const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [groupId, setGroupId] = useState(0); const [models, setModels] = useState<PlatformModel[]>([]); const [modelId, setModelId] = useState("");
  const [checkout, setCheckout] = useState<Checkout>(); const [method, setMethod] = useState(""); const [amount, setAmount] = useState("");
  const [orders, setOrders] = useState<Orders>(); const [page, setPage] = useState(1); const [order, setOrder] = useState<PaymentOrder>(); const [qr, setQr] = useState("");
  const alive = useRef(true);
  const actionRunning = useRef(false);
  const base = snapshot?.gateway ?? gateways[0].url;
  const signedIn = snapshot?.signedIn ?? false;
  const orderId = order?.id; const orderStatus = order?.status;
  const liveScope = useRef({ base, orderId, page });
  liveScope.current = { base, orderId, page };
  const accountEpoch = useRef(0);
  const accountIdentity = useRef("");
  const clearAccountData = useCallback(() => {
    accountEpoch.current += 1;
    setOrder(undefined); setOrders(undefined); setCheckout(undefined); setQr("");
    setMethod(""); setAmount(""); setPage(1); setModels([]); setModelId("");
  }, []);
  const acceptAccount = useCallback((account: PlatformSnapshot) => {
    const identity = account.signedIn ? `${account.gateway}:${account.email}` : "";
    if (identity !== accountIdentity.current) clearAccountData();
    accountIdentity.current = identity;
    setSnapshot(account);
  }, [clearAccountData]);
  const refresh = useCallback(async (expectedBase?: string) => {
    const epoch = accountEpoch.current;
    const account = await platformApi.snapshot();
    const state = await platformApi.connection().catch(() => undefined);
    if (!alive.current || epoch !== accountEpoch.current || (expectedBase && (liveScope.current.base !== expectedBase || account.gateway !== expectedBase))) return;
    acceptAccount(account); setConnection(state); setEmail(account.email);
    setGroupId(previous => account.groups.some(g => g.id === previous) ? previous : account.groups.find(g => g.id === account.selectedGroup)?.id ?? account.groups.find(g => g.platform === "openai")?.id ?? account.groups[0]?.id ?? 0);
    setModelId(previous => previous || account.selectedModel || "");
  }, [acceptAccount]);
  useEffect(() => {
    alive.current = true;
    void refresh().catch(e => { if (alive.current) setError(errorText(e)); }).finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown(v => v - 1), 1000); return () => window.clearTimeout(timer);
  }, [countdown]);
  useEffect(() => {
    if (!signedIn || !groupId || tab !== "models") return;
    let current = true; const epoch = accountEpoch.current;
    void platformApi.models(groupId).then(rows => {
      if (!current || epoch !== accountEpoch.current) return;
      setModels(rows);
      setModelId(previous => rows.some(model => model.id === previous) ? previous : rows[0]?.id ?? "");
    }).catch(reason => { if (current && epoch === accountEpoch.current) setError(errorText(reason)); });
    return () => { current = false; };
  }, [signedIn, groupId, tab, base]);
  useEffect(() => {
    let current = true; const epoch = accountEpoch.current; setQr("");
    if (order?.qr_code) void QRCode.toDataURL(order.qr_code, { width: 240, margin: 2 }).then(url => { if (current && epoch === accountEpoch.current) setQr(url); }).catch(() => undefined);
    return () => { current = false; };
  }, [order?.qr_code]);
  useEffect(() => {
    if (!signedIn || tab !== "recharge") return;
    let current = true; const epoch = accountEpoch.current;
    void Promise.all([platformApi.checkout(), platformApi.orders(page)]).then(([info, rows]) => {
      if (!current || epoch !== accountEpoch.current) return;
      setCheckout(info); setOrders(rows);
      const first = Object.entries(info.methods).find(([, m]) => m.available !== false)?.[0] ?? "";
      setMethod(previous => info.methods[previous]?.available !== false && info.methods[previous] ? previous : first);
    }).catch(e => { if (current && epoch === accountEpoch.current) setError(errorText(e)); });
    return () => { current = false; };
  }, [signedIn, tab, page, base]);
  useEffect(() => {
    if (!orderId || !orderStatus || !signedIn || terminal.has(orderStatus)) return;
    let current = true; let polling = false; const epoch = accountEpoch.current;
    const timer = window.setInterval(() => {
      if (document.hidden || polling) return; polling = true;
      void platformApi.order(orderId).then(async next => {
        if (!current || epoch !== accountEpoch.current) return;
        setOrder(previous => ({ ...previous, ...next }));
        if (next.status === "COMPLETED") {
          await refresh(base);
          const rows = await platformApi.orders(page);
          // Terminal status stops this timer; the same order still owns the result.
          const scope = liveScope.current;
          if (alive.current && epoch === accountEpoch.current && scope.base === base && scope.orderId === orderId && scope.page === page) setOrders(rows);
        }
      }).catch(e => {
        const scope = liveScope.current;
        if (alive.current && epoch === accountEpoch.current && scope.base === base && scope.orderId === orderId) setError(errorText(e));
      }).finally(() => { polling = false; });
    }, 5000);
    return () => { current = false; window.clearInterval(timer); };
  }, [orderId, orderStatus, signedIn, refresh, page, base]);

  async function action(work: () => Promise<void>) {
    if (actionRunning.current) return; actionRunning.current = true;
    const release = acquireNavLock();
    setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (e) {
      if (alive.current) setError(errorText(e));
      if (errorText(e).startsWith("登录已过期")) await refresh().catch(() => undefined);
    }
    finally { actionRunning.current = false; release(); if (alive.current) setBusy(false); }
  }
  async function signIn(event: FormEvent) {
    event.preventDefault();
    await action(async () => {
      if (mode === "forgot") { await platformApi.sendEmail(base, email, true); setNotice(c.resetHint); return; }
      clearAccountData();
      const account = await platformApi.login({ gateway: base, email, password, remember, verificationCode: code }, mode === "register");
      setPassword(""); setCode(""); acceptAccount(account); setEmail(account.email);
      setGroupId(account.groups.find(g => g.id === account.selectedGroup)?.id ?? account.groups.find(g => g.platform === "openai")?.id ?? 0); setModelId(account.selectedModel ?? ""); setTab("models");
    });
  }
  async function signOut(forget = false) {
    await action(async () => {
      const state = await platformApi.connection();
      if (state.backupAvailable) {
        if (!await confirm(c.logoutConfirm)) return;
      }
      await platformApi.logout(forget);
      clearAccountData();
      if (forget) setEmail("");
      await refresh();
    });
  }
  const limit = checkout?.methods[method]; const currency = limit?.currency ?? "CNY";
  const minimum = Math.max(limit?.single_min ?? 0, checkout?.global_min ?? 0);
  const maximum = Math.min(...[limit?.single_max, checkout?.global_max].filter((v): v is number => typeof v === "number" && v > 0), Infinity);
  const fee = limit?.fee_rate ?? checkout?.recharge_fee_rate ?? 0;
  const paymentUrl = safePaymentUrl(order?.payment_url);
  const model = models.find(m => m.id === modelId);
  const methodName = (name: string) => name.startsWith("alipay") ? c.alipay : name.startsWith("wxpay") ? c.wxpay : checkout?.methods[name]?.display_name ?? name;
  const orderLabel = (status: string) => labels[status]?.[chinese ? 0 : 1] ?? status;
  async function launch() { if (currentPlatform() === "windows") await managerApi.winLaunch(); else await managerApi.macLaunch(); }

  return <div className="pop platform-page">
    <NavBar title={c.title} onBack={() => { if (!actionRunning.current) onBack(); }} />
    <div className="scroll scroll-wide platform-scroll">
      <header className="platform-hero"><div><span className="platform-eyebrow">{c.eyebrow}</span><h1>{c.heading}</h1><p>{c.intro}</p></div><span className="platform-orbit" aria-hidden="true"><Icon name="globe" size={40} /></span></header>
      <section className="platform-routes" aria-label={c.chooseNode}>{gateways.map(g => <button key={g.url} className={`platform-route ${base === g.url ? "selected" : ""}`} disabled={busy || loading} aria-pressed={base === g.url} onClick={() => void action(async () => { const next = await platformApi.selectGateway(g.url); acceptAccount(next); setCode(""); setCountdown(0); setOrder(undefined); setPage(1);
        if (next.signedIn && groupId && next.groups.some(group => group.id === groupId)) {
          const rows = await platformApi.models(groupId); setModels(rows);
          setModelId(previous => rows.some(model => model.id === previous) ? previous : next.selectedModel ?? rows[0]?.id ?? "");
        } })}><span className="platform-route-tag">{g.short}</span><span><strong>{chinese ? g.name : g.short === "HK" ? "Hong Kong" : g.short === "CN" ? "China" : "Direct"}</strong><small>{new URL(g.url).host}</small></span>{base === g.url && <Icon name="check" size={16} />}</button>)}</section>
      <div className="platform-route-note"><Icon name="shield" size={14} />{c.gatewayNote}</div>
      {error && <div className="platform-alert error" role="alert"><Icon name="alert" size={18} /><span>{error}</span><button aria-label="Dismiss" onClick={() => setError("")}><Icon name="close" size={14} /></button></div>}
      {notice && <div className="platform-alert" role="status"><Icon name="check" size={18} /><span>{notice}</span></div>}
      {snapshot?.stale && <div className="platform-alert" role="status">{c.stale}</div>}
      <nav className="platform-tabs" aria-label={c.title}>{(["account", "models", "recharge"] as const).map(t => <button key={t} aria-current={tab === t ? "page" : undefined} className={tab === t ? "active" : ""} onClick={() => setTab(t)} disabled={busy}>{c[t]}</button>)}</nav>
      {loading ? <div className="platform-empty"><Icon name="loader" /><p>{c.busy}</p></div> : tab === "account" || !signedIn ? <div className="platform-account-grid">
        <section className="platform-card platform-auth">
          {signedIn ? <><span className="platform-pill"><i />{c.welcome}</span><h2>{snapshot?.email}</h2><div className="platform-balance"><span>{c.balance} · USD</span><strong>{money(snapshot?.balance)}</strong></div>{snapshot?.balance !== undefined && snapshot.balance <= snapshot.lowBalanceThreshold && <p className="platform-low">{c.low}</p>}<div className="platform-button-row"><button className="platform-primary" disabled={busy} onClick={() => setTab("models")}><Icon name="sliders" size={16} />{c.models}</button><button className="platform-secondary" disabled={busy} onClick={() => setTab("recharge")}>{c.recharge}</button></div><div className="platform-links"><button disabled={busy} onClick={() => void action(async () => { await refresh(); setNotice(c.updated); })}>{c.refresh}</button><button disabled={busy} onClick={() => void action(async () => { await managerApi.openUrl(`${base}/usage`); })}>{c.usage}<Icon name="external" size={13} /></button><button disabled={busy} onClick={() => void signOut()}>{c.logout}</button></div></> : <>
            <div className="platform-auth-heading"><h2>{c[mode]}</h2>{mode !== "forgot" && <button className="platform-link" disabled={busy} onClick={() => { setMode(mode === "login" ? "register" : "login"); setPassword(""); setCode(""); }}>{mode === "login" ? c.register : c.login}</button>}</div>
            <form onSubmit={e => void signIn(e)} className="platform-form"><label>{c.email}<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={busy} placeholder="you@example.com" /></label>
              {mode !== "forgot" && <label>{c.password}<input type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} required minLength={6} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>}
              {mode === "register" && snapshot?.publicConfig.email_verify_enabled !== false && <label>{c.code}<div className="platform-code"><input autoComplete="one-time-code" inputMode="numeric" value={code} onChange={e => setCode(e.target.value)} required disabled={busy} /><button type="button" disabled={busy || countdown > 0 || !email.includes("@")} onClick={() => void action(async () => { const result = await platformApi.sendEmail(base, email); setCountdown(result.countdown ?? 60); })}>{countdown > 0 ? `${countdown}s` : c.send}</button></div></label>}
              {mode !== "forgot" && <label className="platform-checkbox"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} disabled={busy} />{c.remember}</label>}
              <button className="platform-primary" type="submit" disabled={busy || (mode === "register" && snapshot?.publicConfig.registration_enabled === false)}>{busy ? c.busy : mode === "forgot" ? c.reset : mode === "register" ? c.registerSubmit : c.submit}<Icon name="chevron" size={16} /></button>
              <p className="platform-fine">{mode === "forgot" ? c.loginHint : c.remembered}</p>
            </form><div className="platform-links"><button disabled={busy} onClick={() => { setMode(mode === "forgot" ? "login" : "forgot"); setPassword(""); }}>{mode === "forgot" ? c.backLogin : c.forgot}</button><button disabled={busy} onClick={() => void signOut(true)}>{c.forget}</button><button disabled={busy} onClick={() => void action(async () => { await managerApi.openUrl(base); })}>{c.portal}<Icon name="external" size={13} /></button></div>
          </>}
        </section>
        <aside className="platform-card platform-guide"><span className="platform-eyebrow">CODEX × CIYUAN</span><h2>{chinese ? "从登录到创作，\n只需三步。" : "From sign-in to creation,\nin three steps."}</h2><ol>{[c.step1, c.step2, c.step3].map((step, i) => <li key={step}><span>0{i + 1}</span><strong>{step}</strong></li>)}</ol><div className="platform-guide-footer"><p><Icon name="shield" size={15} />{c.secure}</p><p><Icon name="folder" size={15} />{c.preserved}</p></div></aside>
      </div> : tab === "models" ? <section className="platform-card platform-models">
        <div className="platform-section-heading"><div><h2>{c.models}</h2><p>{c.syncHint}</p></div><span className={`platform-pill ${connection?.connected ? "" : "muted"}`}><i />{connection?.connected ? c.connected : c.disconnected}</span></div>
        {connection?.connected && <div className="platform-current"><Icon name="check" size={18} /><span><strong>{connection.model}</strong><small>{connection.gateway}</small></span></div>}
        <div className="platform-model-select"><label>{c.group}<select value={groupId} disabled={busy} onChange={e => { setGroupId(Number(e.target.value)); setModels([]); setModelId(""); }}><option value={0}>{c.select}</option>{snapshot?.groups.filter(g => g.platform === "openai" && !g.name.includes("生图")).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label><button className="platform-secondary" disabled={busy || !groupId} onClick={() => void action(async () => { const rows = await platformApi.models(groupId); setModels(rows); setModelId(previous => rows.some(m => m.id === previous) ? previous : rows.find(m => m.id === connection?.model)?.id ?? rows[0]?.id ?? ""); })}><Icon name="refresh" size={16} />{c.sync}</button></div>
        <label className="platform-model-field">{c.model}<select value={modelId} disabled={busy || !models.length} onChange={e => setModelId(e.target.value)}><option value="">{c.noModels}</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        {model && <div className="platform-model-description"><strong>{model.id}</strong><p>{model.description}</p></div>}
        <div className="platform-button-row"><button className="platform-primary" disabled={busy || !modelId} onClick={() => void action(async () => { if (!await confirm(c.launchConfirm)) return; await platformApi.prepareLaunch(); setNotice(c.validating); setConnection(await platformApi.apply(groupId, modelId)); setNotice(c.applied); })}>{busy ? c.busy : c.apply}<Icon name="check" size={16} /></button><button className="platform-secondary" disabled={busy || !modelId} onClick={() => { void action(async () => { if (!await confirm(c.launchConfirm)) return; await platformApi.prepareLaunch(); setNotice(c.validating); setConnection(await platformApi.apply(groupId, modelId)); await launch(); setNotice(c.started); }); }}>{c.applyLaunch}<Icon name="play" size={16} /></button></div>
        <p className="platform-fine">{c.probeNote}</p><div className="platform-links">{connection?.connected && <button disabled={busy} onClick={() => { void action(async () => { if (!await confirm(c.launchConfirm)) return; await platformApi.prepareLaunch(); await launch(); setNotice(c.started); }); }}>{c.launch}</button>}{connection?.backupAvailable && <button disabled={busy} onClick={() => void action(async () => { if (!await confirm(c.launchConfirm)) return; await platformApi.prepareLaunch(); setConnection(await platformApi.restore()); setNotice(c.restored); })}>{c.restore}</button>}</div>
      </section> : <>
        <div className="platform-payment-grid"><section className="platform-card"><h2>{c.recharge}</h2><div className="platform-credit-line">{c.balance}<strong>{money(snapshot?.balance)}</strong></div>{checkout?.balance_disabled ? <p>{c.noPayment}</p> : <form className="platform-form" onSubmit={e => { e.preventDefault(); void action(async () => { setNotice(c.creating); const next = await platformApi.createOrder(Number(amount), method); setOrder(next); setOrders(await platformApi.orders(1)); setPage(1); setNotice(""); }); }}>
          <label>{c.amount} · {currency}<input type="number" inputMode="decimal" step="0.01" required min={minimum > 0 ? minimum : 0.01} max={Number.isFinite(maximum) ? maximum : undefined} value={amount} disabled={busy} onChange={e => setAmount(e.target.value)} placeholder={minimum > 0 ? String(minimum) : "100.00"} /></label><div className="platform-limits"><span>{c.minimum}: {money(minimum, currency)}</span>{Number.isFinite(maximum) && <span>{c.maximum}: {money(maximum, currency)}</span>}<span>{c.fee}: {(fee * 100).toFixed(2)}%</span></div>
          <label>{c.method}<select value={method} disabled={busy} onChange={e => setMethod(e.target.value)}>{Object.entries(checkout?.methods ?? {}).filter(([, m]) => m.available !== false).map(([name]) => <option key={name} value={name}>{methodName(name)}</option>)}</select></label><button className="platform-primary" disabled={busy || !method || !amount || !checkout}>{busy ? c.busy : c.create}<Icon name="chevron" size={16} /></button><p className="platform-fine">{c.paymentNote}</p></form>}</section>
          <section className="platform-card platform-pay-display">{order ? <><div className="platform-section-heading"><h3>{c.activeOrder}</h3><span className="platform-order-status" data-status={order.status}>{orderLabel(order.status)}</span></div><p className="platform-fine">{c.orderNumber}: {order.out_trade_no}</p><div className="platform-order-amount">{money(order.pay_amount, order.currency ?? currency)}</div><p className="platform-fine">{c.credited}: {money(order.amount)}</p>{qr && !terminal.has(order.status) && <figure><img src={qr} width={240} height={240} alt={c.scan} /><figcaption>{c.scan}</figcaption></figure>}{paymentUrl && !terminal.has(order.status) && <button className="platform-secondary" disabled={busy} onClick={() => void action(async () => { await managerApi.openUrl(paymentUrl); })}>{c.pay}<Icon name="external" size={15} /></button>}</> : <div className="platform-empty"><Icon name="grid" size={38} /><p>{c.emptyPayment}</p></div>}</section></div>
        <section className="platform-card platform-orders"><div className="platform-section-heading"><h2>{c.orders}</h2><button className="platform-link" disabled={busy} onClick={() => void action(async () => { setOrders(await platformApi.orders(page)); await refresh(); })}><Icon name="refresh" size={15} />{c.refresh}</button></div>{orders?.items.length ? <div className="platform-table-wrap"><table><thead><tr><th>{c.orderNumber}</th><th>{c.paidAmount}</th><th>{c.credited}</th><th>{c.method}</th><th>{chinese ? "状态" : "Status"}</th><th>{chinese ? "操作" : "Action"}</th></tr></thead><tbody>{orders.items.map(row => <tr key={row.id}><td>{row.out_trade_no}</td><td>{money(row.pay_amount, row.currency ?? "CNY")}</td><td>{money(row.amount)}</td><td>{methodName(row.payment_type)}</td><td><span className="platform-order-status" data-status={row.status}>{orderLabel(row.status)}</span></td><td>{!terminal.has(row.status) && <button className="platform-link" disabled={busy} onClick={() => void action(async () => { setOrder(await platformApi.order(row.id)); })}>{c.resume}</button>}</td></tr>)}</tbody></table></div> : <div className="platform-empty"><p>{c.emptyOrders}</p></div>}<div className="platform-pagination"><button disabled={busy || page === 1} onClick={() => setPage(p => p - 1)}>{c.previous}</button><span>{page} {c.page}</span><button disabled={busy || !orders || page * 10 >= orders.total} onClick={() => setPage(p => p + 1)}>{c.next}</button></div></section>
      </>}
    </div>
  </div>;
}
