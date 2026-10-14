# 代码签名状态 · Code signing

首版 v1.0.0：Windows 无 Authenticode 发行证书。macOS 使用 ad hoc 签名，未做 Developer ID 签名与 Apple 公证。系统可能显示未知发行者提示。
For v1.0.0, Windows installers have no Authenticode publisher signature. macOS uses ad hoc signing without Developer ID or notarization.

独立 Tauri 更新私钥保存在 GitHub Actions Secret，应用仅含公钥。发布流程验证签名并生成 SHA256SUMS。更新签名认证工件字节，不代表系统发行者身份。
An independent private key is stored in Actions Secrets; the app contains its public key. Updater signatures authenticate bytes, not OS publisher identity.

将来启用发行证书须独立 PR 验证。上游证书、镜像桶和发行者身份不用于本项目。
Future certificate integration requires a separate reviewed change. Upstream certificates, buckets and identities are not used.
