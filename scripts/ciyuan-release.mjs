import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseSourceVersions } from "./check-release-version.mjs";

export const releasePlatforms = {
  "windows-x64": { target: "x86_64-pc-windows-msvc", updater: "windows-x86_64", extension: "exe" },
  "windows-arm64": { target: "aarch64-pc-windows-msvc", updater: "windows-aarch64", extension: "exe" },
  "macos-x64": { target: "x86_64-apple-darwin", updater: "darwin-x86_64", extension: "app.tar.gz" },
  "macos-arm64": { target: "aarch64-apple-darwin", updater: "darwin-aarch64", extension: "app.tar.gz" },
};
export function artifactName(version, platform, extension = releasePlatforms[platform]?.extension) {
  if (!releasePlatforms[platform] || !/^\d+\.\d+\.\d+$/.test(version) || !extension) throw new Error("Invalid release identity");
  return `Ciyuan-Codex_${version}_${platform}${extension === "exe" ? "-setup" : ""}.${extension}`;
}
export async function collectArtifacts(platform, sourceRoot, output) {
  const version = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")).version;
  const spec = releasePlatforms[platform];
  if (!spec) throw new Error("Unknown release platform");
  const bundle = join(sourceRoot, "target", spec.target, "release", "bundle");
  await mkdir(output, { recursive: true });
  const directory = join(bundle, spec.extension === "exe" ? "nsis" : "macos");
  const files = await readdir(directory);
  const candidates = files.filter(name => name.endsWith(spec.extension === "exe" ? "-setup.exe" : ".app.tar.gz"));
  if (candidates.length !== 1) throw new Error(`Expected exactly one updater artifact in ${directory}`);
  const destination = artifactName(version, platform);
  await copyFile(join(directory, candidates[0]), join(output, destination));
  await copyFile(join(directory, `${candidates[0]}.sig`), join(output, `${destination}.sig`));
  if (spec.extension !== "exe") {
    const dmgs = (await readdir(join(bundle, "dmg"))).filter(name => name.endsWith(".dmg"));
    if (dmgs.length !== 1) throw new Error("Expected exactly one DMG");
    await copyFile(join(bundle, "dmg", dmgs[0]), join(output, artifactName(version, platform, "dmg")));
  }
}
export async function buildReleaseManifest(tag, sourceRoot, output, publishedAt = new Date().toISOString()) {
  const { version } = assertReleaseSourceVersions(tag, sourceRoot);
  const platforms = {};
  const notes = await readFile(join(sourceRoot, "docs", "releases", `${tag}.md`), "utf8");
  for (const [platform, spec] of Object.entries(releasePlatforms)) {
    const name = artifactName(version, platform);
    const payload = await readFile(join(output, name));
    const signature = (await readFile(join(output, `${name}.sig`), "utf8")).trim();
    if (!payload.length || !signature) throw new Error(`Empty updater artifact or signature: ${name}`);
    platforms[spec.updater] = { signature, url: `https://github.com/ccfwwm/ciyuan-codex/releases/download/${tag}/${name}` };
    if (spec.extension !== "exe" && !(await readFile(join(output, artifactName(version, platform, "dmg")))).length) throw new Error("Empty DMG");
  }
  const manifest = { version, notes, pub_date: publishedAt, platforms };
  await writeFile(join(output, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const names = (await readdir(output)).filter(name => name !== "SHA256SUMS").sort();
  const hashes = await Promise.all(names.map(async name => `${createHash("sha256").update(await readFile(join(output, name))).digest("hex")}  ${name}`));
  await writeFile(join(output, "SHA256SUMS"), `${hashes.join("\n")}\n`);
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, identity, output = "release-assets"] = process.argv.slice(2);
  if (operation === "collect") await collectArtifacts(identity, process.cwd(), resolve(output));
  else if (operation === "manifest") await buildReleaseManifest(identity, process.cwd(), resolve(output));
  else throw new Error("Usage: ciyuan-release.mjs collect <platform> [directory] | manifest <tag> [directory]");
}
