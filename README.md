# iHub Translate

可从 GitHub 直接导入的 iHub 官方 TypeScript 插件。它只实现一个透明的 LibreTranslate 兼容工作流：由用户输入一个自己信任的 HTTPS endpoint、源/目标语言和文本，随后点击 **翻译** 才发出一次 `POST /translate` 请求。

## 网络与隐私边界

- **没有默认翻译服务。** 第一次打开时 endpoint 为空；插件不会自动选择或连接第三方服务。
- 只有用户点击 **翻译** 后，当前文本、语言和（如果填写）API key 才会发送到所填的 HTTPS 地址。请求使用 `credentials: "omit"` 与 `referrerPolicy: "no-referrer"`，不会附带 cookie 或 referrer。
- API key 只保留在当前页面的密码输入框和这一次请求体中；插件不使用 iHub settings、`localStorage` 或 `sessionStorage`，关闭页面时也会清空该字段。
- endpoint、文本和结果同样不由插件持久化；**清除会话数据** 会立即清空当前页面的四项内容。
- 服务端的数据保留、日志、地区和使用条款由用户选择的 endpoint 决定。请只连接你信任、并允许 WebView CORS 请求的服务。
- 清单只请求三项能力：`network`（用户配置的 HTTPS LibreTranslate 兼容 endpoint）、`clipboard.write`（仅在点击 **复制结果** 时）和 `launcherContext.text`。后者只允许用户明确选择 `translate-launcher-text` 前端命令时消费一次文本；到达后只预填输入框，仍必须由用户选择 endpoint 并点击 **翻译**。它不读取剪贴板、不后台翻译、不自动复制，也不发通知。

## 更新行为

清单的 `update.autoUpdate: true` 允许 iHub 自动检查 stable 更新；发现后，用户仍需明确选择应用更新。本插件不自行下载、静默安装或在后台执行更新。

## 服务兼容性

endpoint 可填写服务根地址（插件补上 `/translate`）或完整的 `/translate` URL。插件会拒绝 HTTP、内嵌账号/密码、query 与 hash，以避免无意把凭据或内容暴露到不安全地址。

请求体遵循 LibreTranslate 的 JSON 形状：

```json
{
  "q": "Hello",
  "source": "auto",
  "target": "zh",
  "format": "text",
  "api_key": "optional-session-only-key"
}
```

服务需要返回：

```json
{ "translatedText": "你好" }
```

这不是离线翻译引擎，也不会绕过服务端认证、配额或 CORS。网络失败提示不会回显远端错误体，以避免错误诊断意外包含提交的文本或凭据。

## 包结构

```text
plugin.json            # v1 清单；network + clipboard.write + launcherContext.text
src/index.html         # 审阅友好的离线界面源
src/main.ts            # TypeScript 请求、会话与 iHub bridge 逻辑
scripts/build.mjs      # 从 src/ 重建提交的 dist/index.html
scripts/verify-dist.mjs
tsconfig*.json
dist/index.html        # 已提交、供 iHub 直接加载
dist/main.js           # 已提交、无运行时 npm 依赖
```

Git 导入和日常运行只读取 `plugin.json` 与已提交的 `dist/`，不会运行 `pnpm install`、构建脚本、CDN 资源或安装钩子。

## 本地开发与可复现验证

要求 Node.js 22+ 与 pnpm 11：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify
```

`verify` 会进行严格 TypeScript 检查、重建 `dist/`，并断言清单仍为最小权限、产物不含远程资源、前端不使用持久化或剪贴板读取 API，同时输出清单和产物 SHA-256。
