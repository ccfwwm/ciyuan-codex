import { confirm } from "@tauri-apps/plugin-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import capability from "../../src-tauri/capabilities/default.json";

const invoke = vi.hoisted(() => vi.fn());
beforeEach(() => { window.__TAURI_INTERNALS__ = { invoke }; });
afterEach(() => { vi.resetAllMocks(); delete window.__TAURI_INTERNALS__; });

describe("native confirmation contract", () => {
  it.each([ ["Ok", true], ["Cancel", false] ])("maps %s using the permitted message command", async (result, accepted) => {
    vi.mocked(invoke).mockImplementation(async command => {
      expect(command).toBe("plugin:dialog|message");
      expect(capability.permissions).toContain("dialog:allow-message");
      return result;
    });
    expect(await confirm("Save your work first.")).toBe(accepted);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("propagates IPC failures instead of accepting an unconfirmed operation", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("dialog unavailable"));
    await expect(confirm("Save your work first.")).rejects.toThrow("dialog unavailable");
  });
});
