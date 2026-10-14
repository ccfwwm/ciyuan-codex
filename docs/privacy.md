# 隐私政策 · Privacy

生效日期 / Effective date: 2026-10-14

本政策适用于词元互联 Codex。账户、充值和模型请求通过所选 Sub2API 节点处理；官方 Codex、GitHub 和支付服务各自适用其服务条款。
This policy covers Ciyuan Codex. Selected Sub2API routes process accounts, billing and model requests. Other services retain their own terms.

## 账户与保存 · Storage

邮箱、密码及验证码通过 HTTPS 发往所选节点。密码不长期保存。默认记住登录将访问与刷新 Token 保存在 Windows 凭据管理器或 macOS Keychain。关闭记住后会话仅留在进程内。专用 API Key 仍保存在凭据库，供直接启动 Codex 使用。
Email, password and codes are sent over HTTPS. Passwords are not persisted. Remembered sessions and dedicated keys use the OS vault. Disabling remember keeps the session in memory; the dedicated key remains available for configured Codex.

节点、邮箱、分组与模型偏好保存在独立目录。退出恢复管理字段并清除本地会话与 Key；清除保存信息还删除邮箱和选择。服务器专用 Key 可在平台撤销或再次复用，其他客户端 Key 不修改。
Preferences store route, email, group and model. Sign-out restores configuration and clears local secrets. Forget also clears email/selection. Dedicated server keys remain reusable and can be revoked on the platform.

## 网络与配置 · Network

应用请求账户、余额、目录、充值渠道、订单和邮件。应用模型前发送正常计费的小型 Responses 工具测试。实际 Codex 请求直接发往所选节点并产生使用记录。使用记录按钮打开当前节点 /usage，浏览器采用正常登录流程。
Applying sends a small billed streaming tool test. Codex requests go to the selected route and produce usage records. Usage uses normal browser sign-in.

应用只为接入读取与备份 Codex 配置，不读取或上传工作区和聊天记录。备份可能含原配置的敏感字段，保存在本机，不进入诊断日志。应用无项目运营的分析或广告服务。
Configuration backups stay local and can contain sensitive fields. The manager does not upload workspace files or chat history and contains no project-operated analytics or advertising.

管理器检查本仓库 GitHub 更新源；Codex 安装、更新和皮肤访问既有公开来源。日志默认本地保存，分享前请核对。本项目不部署官网与下载路由。
Manager updates use this repository's GitHub feed; installation/skins use existing public sources. Diagnostics remain local unless shared. No separate website/router is deployed.
