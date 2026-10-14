import { invoke } from "@tauri-apps/api/core";

export const gateways = [
  { url: "https://code.aicodeme.xyz", name: "中转直连", short: "XYZ" },
  { url: "https://code.aicodeme.cn", name: "词元互联中转", short: "CN" },
  { url: "https://hkcode.aicodeme.xyz", name: "中转香港", short: "HK" },
] as const;
export interface PlatformGroup { id: number; name: string; platform: string }
export interface PlatformModel { id: string; name: string; description: string }
export interface PlatformSnapshot {
  signedIn: boolean; gateway: string; email: string; balance?: number;
  stale: boolean; groups: PlatformGroup[]; lowBalanceThreshold: number;
  publicConfig: Record<string, unknown>;
  selectedGroup?: number; selectedModel?: string;
}
export interface CodexConnection { connected: boolean; model?: string; gateway?: string; backupAvailable: boolean }
export interface MethodLimit {
  currency?: string; display_name?: string; available?: boolean; single_min: number;
  single_max: number; fee_rate: number;
}
export interface Checkout {
  methods: Record<string, MethodLimit>; global_min: number; global_max: number;
  balance_disabled: boolean; help_text?: string; recharge_fee_rate?: number;
}
export interface PaymentOrder {
  id: number; out_trade_no: string; status: string; amount: number; pay_amount: number;
  currency?: string; payment_type: string; created_at?: string; expires_at?: string;
  payment_url?: string; qr_code?: string;
}
export interface Orders { items: PaymentOrder[]; total: number; page: number; page_size: number }
export interface LoginInput { gateway: string; email: string; password: string; remember: boolean; verificationCode?: string }

export function paymentOrder(value: unknown): PaymentOrder {
  if (!value || typeof value !== "object") throw new Error("平台返回的订单不完整。 / Invalid payment order.");
  const raw = value as Record<string, unknown>;
  const data = (raw.order ?? raw.payment_order ?? raw) as Record<string, unknown>;
  const order = { ...data, id: data.id ?? data.order_id, status: data.status ?? (data.order_id ? "PENDING" : undefined) } as PaymentOrder;
  if (!Number.isSafeInteger(order.id) || order.id <= 0 || typeof order.status !== "string") {
    throw new Error("平台返回的订单不完整。 / Invalid payment order.");
  }
  const url = order.payment_url ?? data.pay_url ?? raw.payment_url;
  const qr = order.qr_code ?? raw.qr_code;
  return { ...order, ...(typeof url === "string" ? { payment_url: url } : {}),
    ...(typeof qr === "string" ? { qr_code: qr } : {}) };
}
export function safePaymentUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try { const url = new URL(raw); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

export const platformApi = {
  snapshot: () => invoke<PlatformSnapshot>("platform_snapshot"),
  login: (input: LoginInput, register = false) => invoke<PlatformSnapshot>("platform_login", { input, register }),
  selectGateway: (base: string) => invoke<PlatformSnapshot>("platform_select_gateway", { base }),
  sendEmail: (base: string, address: string, reset = false) => invoke<{ countdown?: number }>("platform_send_email", { base, address, reset }),
  logout: (forget = false) => invoke<void>("platform_logout", { forget }),
  models: (groupId: number) => invoke<PlatformModel[]>("platform_models", { groupId }),
  apply: (groupId: number, modelId: string) => invoke<CodexConnection>("platform_apply", { groupId, modelId }),
  connection: () => invoke<CodexConnection>("codex_connection_status"),
  restore: () => invoke<CodexConnection>("codex_connection_restore"),
  prepareLaunch: () => invoke<void>("codex_connection_prepare_launch"),
  checkout: () => invoke<Checkout>("platform_checkout"),
  orders: (page = 1) => invoke<Orders>("platform_orders", { page }),
  createOrder: async (amount: number, paymentType: string) => paymentOrder(await invoke("platform_create_order", { amount, paymentType })),
  order: async (orderId: number) => paymentOrder(await invoke("platform_order", { orderId })),
};
