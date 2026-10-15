import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import { AiPlatform } from "./AiPlatform";
import { gateways, platformApi, type PlatformSnapshot } from "../../services/platformApi";
import { managerApi } from "../../services/managerApi";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("../../services/platformApi", async (original) => {
  const actual = await original<typeof import("../../services/platformApi")>();
  return { ...actual, platformApi: Object.fromEntries(Object.keys(actual.platformApi).map(key => [key, vi.fn()])) };
});
vi.mock("../../services/managerApi", () => ({ managerApi: { openUrl: vi.fn(), winLaunch: vi.fn(), macLaunch: vi.fn() } }));

const snapshot: PlatformSnapshot = { signedIn: false, gateway: gateways[0].url, email: "", stale: false, groups: [], lowBalanceThreshold: 5,
  publicConfig: { registration_enabled: true, email_verify_enabled: true } };
function show() { render(<ThemeProvider><I18nProvider><AiPlatform onBack={() => undefined} /></I18nProvider></ThemeProvider>); }
beforeEach(() => { window.__TAURI_INTERNALS__ = { invoke }; vi.resetAllMocks(); vi.mocked(platformApi.snapshot).mockResolvedValue(snapshot); vi.mocked(platformApi.connection).mockResolvedValue({ connected: false, backupAvailable: false }); });
afterEach(() => { delete window.__TAURI_INTERNALS__; vi.useRealTimers(); vi.restoreAllMocks(); });
const account = { ...snapshot, signedIn: true, email: "fixture@example.test", balance: 2, groups: [{ id: 3, name: "Codex", platform: "openai" }] };

describe("AI platform account flows", () => {
  it("waits for Codex shutdown before applying and launches only after commit", async () => {
    const events: string[] = [];
    vi.mocked(platformApi.snapshot).mockResolvedValue(account);
    vi.mocked(platformApi.models).mockResolvedValue([{ id: "gpt-6.1-sol", name: "Sol", description: "verified" }]);
    vi.mocked(invoke).mockResolvedValue("Ok");
    let stopped!: () => void;
    vi.mocked(platformApi.prepareLaunch).mockImplementation(() => new Promise<void>(resolve => { stopped = () => { events.push("stopped"); resolve(); }; }));
    vi.mocked(platformApi.apply).mockImplementation(async () => { events.push("applied"); return { connected: true, backupAvailable: true }; });
    vi.mocked(managerApi.macLaunch).mockImplementation(async () => { events.push("launched"); });
    vi.mocked(managerApi.winLaunch).mockImplementation(async () => { events.push("launched"); });
    show(); await screen.findByText(account.email);
    fireEvent.click(screen.getAllByRole("button", { name: "Model connection" })[0]);
    await screen.findByRole("option", { name: "Sol" });
    fireEvent.click(screen.getByRole("button", { name: "Verify, apply & launch" }));
    await waitFor(() => expect(platformApi.prepareLaunch).toHaveBeenCalled());
    expect(platformApi.apply).not.toHaveBeenCalled();
    await act(async () => { stopped(); });
    await waitFor(() => expect(events).toEqual(["stopped", "applied", "launched"]));
    // Exercise the real dialog SDK: the old window.confirm shim invoked a
    // removed command despite the deprecated allow-confirm permission.
    expect(invoke).toHaveBeenCalledWith("plugin:dialog|message", expect.objectContaining({ buttons: "OkCancel" }), undefined);
  });
  it("awaits native asynchronous cancellation before applying or closing Codex", async () => {
    vi.mocked(platformApi.snapshot).mockResolvedValue(account);
    vi.mocked(platformApi.models).mockResolvedValue([{ id: "gpt-6.1-sol", name: "Sol", description: "verified" }]);
    vi.mocked(invoke).mockResolvedValue("Cancel");
    show(); await screen.findByText(account.email);
    fireEvent.click(screen.getAllByRole("button", { name: "Model connection" })[0]);
    await screen.findByRole("option", { name: "Sol" });
    fireEvent.click(screen.getByRole("button", { name: "Verify, apply & launch" }));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Verify, apply & launch" })).toBeEnabled());
    expect(platformApi.apply).not.toHaveBeenCalled();
    expect(platformApi.prepareLaunch).not.toHaveBeenCalled();
  });
  it("registers with a verification code and honors remember disabled", async () => {
    vi.mocked(platformApi.sendEmail).mockResolvedValue({ countdown: 60 });
    vi.mocked(platformApi.login).mockResolvedValue(account);
    vi.mocked(platformApi.models).mockResolvedValue([{ id: "gpt-6.1-sol", name: "Sol", description: "verified" }]);
    show(); await screen.findByLabelText("Email");
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: account.email } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "fixture-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "60s" })).toBeDisabled());
    fireEvent.change(screen.getByLabelText("Email code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Remember sign-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(platformApi.login).toHaveBeenCalledWith({ gateway: gateways[0].url, email: account.email, password: "fixture-secret", remember: false, verificationCode: "123456" }, true));
    expect(await screen.findByRole("option", { name: "Sol" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });
  it("restores an existing session, handles expiry, and forgets saved information", async () => {
    vi.mocked(platformApi.snapshot).mockResolvedValueOnce(account).mockResolvedValue({ ...snapshot, email: account.email });
    show(); await screen.findByText(account.email);
    fireEvent.click(screen.getByRole("button", { name: "Refresh account" }));
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Forget saved account" }));
    await waitFor(() => expect(platformApi.logout).toHaveBeenCalledWith(true));
  });
  it("logs out and removes model and payment state", async () => {
    vi.mocked(platformApi.snapshot).mockResolvedValueOnce(account).mockResolvedValue(snapshot);
    show(); await screen.findByText(account.email);
    fireEvent.click(screen.getByRole("button", { name: "Sign out & disconnect" }));
    await waitFor(() => expect(platformApi.logout).toHaveBeenCalledWith(false));
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
  });
  it("awaits confirmation before the backend shutdown and logout, and honors cancellation", async () => {
    vi.mocked(platformApi.snapshot).mockResolvedValue(account);
    vi.mocked(platformApi.connection).mockResolvedValue({ connected: true, backupAvailable: true });
    let confirm!: (result: string) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise<string>(resolve => { confirm = resolve; }));
    show(); await screen.findByText(account.email);
    fireEvent.click(screen.getByRole("button", { name: "Sign out & disconnect" }));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(platformApi.logout).not.toHaveBeenCalled();
    await act(async () => { confirm("Cancel"); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out & disconnect" })).toBeEnabled());
    expect(platformApi.logout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign out & disconnect" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await act(async () => { confirm("Ok"); });
    await waitFor(() => expect(platformApi.logout).toHaveBeenCalledWith(false));
  });
  it("discards the previous account's payment and outstanding poll after session loss", async () => {
    const pending = { id: 7, out_trade_no: "old-account", status: "PENDING", amount: 10, pay_amount: 10, currency: "CNY", payment_type: "alipay", payment_url: "https://pay.example.test/old-account" };
    const other = { ...account, email: "other@example.test" };
    vi.mocked(platformApi.snapshot).mockResolvedValueOnce(account).mockResolvedValue({ ...snapshot, email: account.email });
    vi.mocked(platformApi.login).mockResolvedValue(other);
    vi.mocked(platformApi.models).mockResolvedValue([]);
    vi.mocked(platformApi.checkout).mockResolvedValue({ methods: { alipay: { currency: "CNY", single_min: 10, single_max: 100, fee_rate: 0 } }, global_min: 10, global_max: 100, balance_disabled: false });
    vi.mocked(platformApi.orders).mockResolvedValue({ items: [], total: 0, page: 1, page_size: 10 });
    vi.mocked(platformApi.createOrder).mockResolvedValue(pending);
    let resolvePoll!: (value: typeof pending) => void;
    vi.mocked(platformApi.order).mockImplementation(() => new Promise(resolve => { resolvePoll = resolve; }));
    show(); await screen.findByText(account.email);
    fireEvent.click(screen.getAllByRole("button", { name: "Payments & orders" })[0]);
    await screen.findByLabelText("Recharge amount · CNY");
    fireEvent.change(screen.getByLabelText("Recharge amount · CNY"), { target: { value: "10" } });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create payment order" })); });
    expect(screen.getByRole("button", { name: "Open payment page" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    vi.useRealTimers();
    expect(platformApi.order).toHaveBeenCalledWith(7);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh account" }));
    await screen.findByLabelText("Password");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: other.email } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "fixture-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in & connect" }));
    await waitFor(() => expect(platformApi.login).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Payments & orders" })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole("button", { name: "Payments & orders" })[0]);
    await screen.findByLabelText("Recharge amount · CNY");
    await act(async () => { resolvePoll(pending); });
    expect(screen.queryByRole("button", { name: "Open payment page" })).not.toBeInTheDocument();
    expect(screen.queryByText("old-account")).not.toBeInTheDocument();
  });
  it("refreshes balance and orders after a simulated completed payment", async () => {
    const pending = { id: 1, out_trade_no: "fixture-1", status: "PENDING", amount: 10, pay_amount: 10, currency: "CNY", payment_type: "alipay" };
    let finishRefresh!: (value: PlatformSnapshot) => void;
    vi.mocked(platformApi.snapshot).mockResolvedValueOnce(account).mockImplementation(() => new Promise(resolve => { finishRefresh = resolve; }));
    vi.mocked(platformApi.checkout).mockResolvedValue({ methods: { alipay: { currency: "CNY", single_min: 10, single_max: 100, fee_rate: 0 } }, global_min: 10, global_max: 100, balance_disabled: false });
    vi.mocked(platformApi.orders)
      .mockResolvedValue({ items: [{ ...pending, status: "COMPLETED" }], total: 1, page: 1, page_size: 10 })
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, page_size: 10 })
      .mockResolvedValueOnce({ items: [pending], total: 1, page: 1, page_size: 10 });
    vi.mocked(platformApi.createOrder).mockResolvedValue(pending);
    vi.mocked(platformApi.order).mockResolvedValue({ ...pending, status: "COMPLETED" });
    show(); await screen.findByText(account.email);
    fireEvent.click(screen.getAllByRole("button", { name: "Payments & orders" })[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create payment order" })).toBeDisabled());
    fireEvent.change(screen.getByLabelText("Recharge amount · CNY"), { target: { value: "10" } });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create payment order" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    // Allow terminal status to render and clean up the interval before balance resolves.
    await act(async () => { finishRefresh({ ...account, balance: 12 }); });
    expect(platformApi.order).toHaveBeenCalledWith(1);
    expect(platformApi.snapshot).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/12\.00/)).toBeInTheDocument();
    expect(screen.getAllByText("Completed")).toHaveLength(2);
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
  });
  it("resumes a pending order from history after reopening the application", async () => {
    const pending = { id: 8, out_trade_no: "resume-order", status: "PENDING", amount: 10, pay_amount: 10, currency: "CNY", payment_type: "alipay", payment_url: "https://pay.example.test/resume" };
    vi.mocked(platformApi.snapshot).mockResolvedValue(account);
    vi.mocked(platformApi.checkout).mockResolvedValue({ methods: {}, global_min: 10, global_max: 100, balance_disabled: true });
    vi.mocked(platformApi.orders).mockResolvedValue({ items: [pending], total: 1, page: 1, page_size: 10 });
    vi.mocked(platformApi.order).mockResolvedValue(pending);
    show(); await screen.findByText(account.email);
    fireEvent.click(screen.getAllByRole("button", { name: "Payments & orders" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Resume payment" }));
    await screen.findByRole("button", { name: "Open payment page" });
    expect(platformApi.order).toHaveBeenCalledWith(8);
    expect(platformApi.createOrder).not.toHaveBeenCalled();
  });
  it("defaults to XYZ, remembers the session and never changes route after a failed switch", async () => {
    show();
    const direct = await screen.findByRole("button", { name: /XYZ.*Direct/ });
    await waitFor(() => expect(direct).toBeEnabled());
    expect(direct).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: "Remember sign-in" })).toBeChecked();
    vi.mocked(platformApi.selectGateway).mockRejectedValue("Network unavailable");
    fireEvent.click(screen.getByRole("button", { name: /HK.*Hong Kong/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
    expect(direct).toHaveAttribute("aria-pressed", "true");
  });
  it("shows cached balance and opens usage on the currently selected node", async () => {
    vi.mocked(platformApi.snapshot).mockResolvedValue({ ...snapshot, signedIn: true, email: "fixture@example.test", gateway: gateways[2].url, balance: 12.5, stale: true });
    show();
    expect(await screen.findByText("fixture@example.test")).toBeInTheDocument();
    expect(screen.getByText(/Showing cached data/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /View usage/ }));
    await waitFor(() => expect(managerApi.openUrl).toHaveBeenCalledWith(`${gateways[2].url}/usage`));
  });
  it("requests reset by email and clears the password field when switching flow", async () => {
    show(); await screen.findByLabelText("Email");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "fixture@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "fixture-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Send reset email/ }));
    await waitFor(() => expect(platformApi.sendEmail).toHaveBeenCalledWith(gateways[0].url, "fixture@example.test", true));
    expect(await screen.findByText(/Reset email sent/)).toBeInTheDocument();
  });
});
