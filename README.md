# 网站油猴脚本发现器

在当前网站一键查找可用的 **GreasyFork** 脚本。针对「打开是空的」这一类网络问题做了多线路自动回退，国内网络下也能用。

> 本仓库是 [GreasyFork #539863](https://greasyfork.org/scripts/539863) v5.2 的修复与增强版（v6.1.1）。

## 问题背景

原版 v5.2 在部分网络环境下会显示「未找到适用于 xx 的脚本」，但实际上**请求根本没成功**。

根因在抓取层的异常处理：

```js
// v5.2
try {
    // ...GM_xmlhttpRequest 请求 greasyfork.org
} catch (e) {
    console.error(e);
    return [];          // ← 网络失败被当成「没有结果」
}
```

失败和「这个站点确实没有脚本」走的是同一个返回值，UI 也只能显示同一句话。于是用户看到的是「没有脚本」，真相是「没连上」。

此外 `greasyfork.org` 在部分网络下会被 **TLS/SNI 重置**（TCP 能连、证书握手中断），这种情况下无论怎么重试直连都不会成功，必须换线路。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（篡改猴）
2. 用 Tampermonkey 打开下面任意一个安装地址（国内网络请优先用镜像）：

| 线路 | 安装地址 |
| --- | --- |
| GitHub 官方 raw | `https://raw.githubusercontent.com/qibo30/userscript-finder/main/userscript-finder.user.js` |
| **国内镜像 ①** | `https://ghproxy.net/https://raw.githubusercontent.com/qibo30/userscript-finder/main/userscript-finder.user.js` |
| **国内镜像 ②** | `https://gh-proxy.com/https://raw.githubusercontent.com/qibo30/userscript-finder/main/userscript-finder.user.js` |

3. 任意网页右下角会出现 🔍 悬浮按钮，点击打开面板

> `raw.githubusercontent.com` 在国内通常直连不通（需要代理）。上面两个镜像实测国内可直连，返回内容与官方 raw 完全一致。

### 自动更新

脚本已内置 `@updateURL` / `@downloadURL`，Tampermonkey 会定期检查新版本：

- `@updateURL` 走 `ghproxy.net` 镜像（国内可直连）
- `@downloadURL` 走 `gh-proxy.com` 镜像

两个镜像都是同一条 raw 的转发，内容与 GitHub 官方完全一致（已验证 sha256 相同）。想改回官方地址，在 Tampermonkey 的脚本编辑页把这两行改掉即可。

### 装不上 / 一直提示无法访问？

1. 换另一个镜像地址重试（上面两个镜像轮流试）
2. 在 Tampermonkey 里手动新建脚本，把 `userscript-finder.user.js` 的内容整段粘贴进去保存（不依赖网络）
3. 检查 Tampermonkey 的「安全」设置里是否允许了 `@connect *`

## 使用

| 操作 | 效果 |
| --- | --- |
| 左键点 🔍 | 打开/关闭脚本列表面板 |
| 右键点 🔍 | 打开功能菜单（切换线路 / 重取 / 最小化 / 重置位置 / 隐藏 30 秒） |
| 双击 🔍 | 最小化 / 恢复图标 |
| 按住拖动 | 移动按钮位置（自动记忆，并夹在视口内） |
| `Alt` + `F` | 打开/关闭面板 |
| `Esc` | 关闭面板 |

面板内可调整：排序方式、显示条数（20 / 50 / 100 / 全部）、仅看近一年、结果内搜索。

## 多线路自动回退

脚本按顺序尝试下列线路，第一个成功的会被记住，下次优先使用：

| 线路 | 说明 |
| --- | --- |
| **官方直连** | 直接请求 `greasyfork.org`，网络正常时最快 |
| **Jina 中转** | 经 `r.jina.ai` 读取原始 HTML，用于直连被重置的网络 |
| **自定义中转** | 你自己的反代/中转前缀，右键菜单里设置 |

**右键 🔍 → 「切换线路…」** 可展开子菜单手动指定线路：

- **自动（推荐）** — 按顺序回退，记住可用线路
- **官方直连 / Jina 中转 / 自定义中转** — 只用这一条，不再回退

手动指定后如果失败，会明确报出失败原因，并提示「切回自动」，不会静默换线路。

> ⚠️ Jina 是第三方公共中转：内容会经过它，且有速率限制、可能随时失效。介意的话请在右键菜单里配置自己的中转前缀。

## v5.2 → v6.1.1 修复清单

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | **核心**：请求失败与「确实没有脚本」返回同一个 `[]`，UI 显示同一句话 | 抓取层区分「线路失败」与「确实为空」，UI 分开显示并给出失败原因 |
| 2 | 直连被 TLS/SNI 重置时无路可走 | 多线路自动回退 + 记住可用线路 |
| 3 | 首次失败被 `container.dataset.loaded` 标记为「已加载」，永不重试 | 每次打开都可重试，新增「重试」按钮 |
| 4 | 按钮坐标不校验视口，存过屏外坐标就永久看不见，重置入口也跟着看不见 | 加载与窗口变化时自动夹回视口，并注册油猴菜单兜底 |
| 5 | `daily_installs` 被特判成不发 `sort` 参数，该选项实际无效 | 始终发送 `?sort=` |
| 6 | 无 `@noframes`，在每个 iframe 里各注入一套 UI | 加 `@noframes` |
| 7 | 强制「一年内更新」+ 固定 20 条，结果偏少偏旧 | 改为可选过滤 + 条数可调（默认 50） |
| 8 | 用 `innerHTML` 拼接第三方标题/描述，存在 XSS 风险 | 全部走 `textContent` |
| 9 | 广告位 `<li class="ad-entry">` 被解析成 `Untitled` 假条目 | 跳过广告位 |
| 10 | — | 新增结果内搜索、评分/日安装量展示、30 分钟结果缓存、`Alt+F` |

### v6.1.1

| # | 变更 |
| --- | --- |
| 11 | 增加 `@updateURL` / `@downloadURL`（走国内镜像），Tampermonkey 可自动检查更新 |
| 12 | 增加 `@homepageURL` / `@supportURL`，指向本仓库与 issue 页 |

## 测试

测试用 [jsdom](https://github.com/jsdom/jsdom) 真实执行脚本，覆盖网络回退、空结果、错误恢复、XSS、位置自愈与线路选择。

```bash
cd test
npm install          # 或 pnpm install
npm test
```

也可以单独跑：

```bash
node run.mjs         # 主流程 6 个场景（真实网络 / 固定 HTML / 离线 / 空站点 / 屏外坐标 / 排序参数）
node edge.mjs        # 广告位跳过、XSS、错误后重开与重试按钮
node filters.mjs     # 条数、搜索、近一年过滤、排序切换、缓存
node channel.mjs     # 线路选择 10 个场景（自动回退 / 手动锁定 / 自愈 / 子菜单）
```

`run.mjs` 里的「真实网络」场景会真的发请求，需要能访问 `greasyfork.org` 或 `r.jina.ai`。

测试夹具 `test/fixtures/bysite.html` 是真实的 GreasyFork by-site 页面（100 条脚本 + 1 条广告位），`empty.html` 是真实的「没有脚本」页面，用来保证解析逻辑对着真实 DOM 契约。

## 项目结构

```
userscript-finder.user.js     # 脚本本体（唯一需要安装的文件）
test/
  run.mjs edge.mjs filters.mjs channel.mjs
  fixtures/bysite.html        # 真实 by-site 页面（100 条 + 广告位）
  fixtures/empty.html         # 真实「无脚本」页面
  package.json
```

## 已知限制

- GreasyFork 没有可用的公开 JSON API（`.json` 端点返回空），因此解析的是 HTML，站点改版可能导致解析失效。
- 单页最多 100 条结果，脚本不翻页。
- 子域识别使用简化的二级域名提取，`co.uk` 一类的多级后缀已处理，但非常规后缀可能识别不准。

## License

MIT
