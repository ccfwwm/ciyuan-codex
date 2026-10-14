import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { artifactName, buildReleaseManifest, releasePlatforms } from "./ciyuan-release.mjs";
import { assertReleaseSourceVersions } from "./check-release-version.mjs";

const packageJson = await readFile("package.json", "utf8");
const workflow = await readFile(".github/workflows/release.yml", "utf8");
describe("Ciyuan GitHub release", () => {
  it("binds release tags to all six version declarations", () => {
    const version = JSON.parse(packageJson).version;
    expect(assertReleaseSourceVersions(`v${version}`, process.cwd()).entries).toHaveLength(6);
    expect(() => assertReleaseSourceVersions("v99.0.0", process.cwd())).toThrow();
  });
  it("builds all four native architectures before publication with fixed actions", () => {
    for (const spec of Object.values(releasePlatforms)) expect(workflow).toContain(spec.target);
    expect(workflow).toContain("needs: [validate, build]");
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("verify-release-artifacts.mjs");
    expect(workflow).not.toMatch(/Wangnov|MANAGER_R2|MANAGER_IHEP|APPLE_API/);
    const actions = [...workflow.matchAll(/uses: (\S+)/g)].map(match => match[1]);
    expect(actions.every(action => /@[0-9a-f]{40}$/.test(action))).toBe(true);
  });
  it("requires every installer and signature before producing a complete checksummed manifest", async () => {
    const output = await mkdtemp(join(tmpdir(), "ciyuan-release-"));
    const version = JSON.parse(packageJson).version;
    try {
      await expect(buildReleaseManifest(`v${version}`, process.cwd(), output)).rejects.toThrow();
      // The temporary notes fixture avoids modifying real release notes.
      for (const [platform, spec] of Object.entries(releasePlatforms)) {
        await writeFile(join(output, artifactName(version, platform)), "fixture");
        await writeFile(join(output, artifactName(version, platform) + ".sig"), "fixture-signature");
        if (spec.extension !== "exe") await writeFile(join(output, artifactName(version, platform, "dmg")), "fixture-dmg");
      }
      const manifest = await buildReleaseManifest(`v${version}`, process.cwd(), output, "2026-10-14T00:00:00Z");
      expect(Object.keys(manifest.platforms)).toHaveLength(4);
      for (const entry of Object.values(manifest.platforms)) expect(entry.url).toContain(`/ccfwwm/ciyuan-codex/releases/download/v${version}/`);
      const sums = await readFile(join(output, "SHA256SUMS"), "utf8");
      for (const line of sums.trim().split("\n")) {
        const [hash, name] = line.split("  ");
        expect(createHash("sha256").update(await readFile(join(output, name))).digest("hex")).toBe(hash);
      }
    } finally { await rm(output, { recursive: true, force: true }); }
  });
});
