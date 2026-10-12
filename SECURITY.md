# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅        |

> **版本更新机制**：每个新版本发布前，将旧版本移出支持表并标注 EOL 日期。最新版本接收所有安全修复，旧版本仅在严重漏洞（CVSS >= 9.0）时回溯修补。

## Reporting a Vulnerability

 如发现安全相关问题，请通过以下任一方式**私下**提交，切勿使用公开 Issue：

- **GitHub Private Vulnerability Reporting**：直接在 GitHub 仓库 → "Security" → "Advisories" → "Report a vulnerability"（首选，团队 24h 内确认收件）
- **镜像平台**：GitCode / Gitee 的 Issue 中标注 `[SECURITY]` 前缀并说明不公开披露（次选）

### 本项目适合披露的安全问题范围

本项目为 **文档/Skill 类开源项目**，不包含运行时服务。适合披露的安全问题主要包括：

- 示例代码中的安全隐患（如 prompt 注入示例未正确展示防御方式）
- 文档中推荐了不安全的配置（如 `NODE_ENV=production` 下建议关闭 HTTPS）
- npm/pip 依赖的版本包含已知漏洞（需注明 CVE 编号）
- Skill 文件内容可被用于构造恶意注入载荷

### 不适合披露的范围

- 使用本 Skill 构建的第三方应用自身的安全问题 → 联系该应用维护者
- 非安全性的 Bug / 功能请求 → 使用普通 Issue

### 漏洞修复 SLA 承诺

| 阶段 | 时间承诺 |
|------|---------|
| 确认收到报告 | 48 小时内 |
| 确认漏洞有效性 | 确认后 5 个工作日内 |
| 发布修复（严重度 High 及以上） | 确认后 7 天内 |
| 公开披露 | 修复发布后 30 天（或与维护者协商） |

报告时建议包含：问题描述、受影响文件/节点、受复现步骤、建议修复方式。
