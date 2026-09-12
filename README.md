# DAFEIYU — DeepSeek 余额小鲸鱼（酒馆纯前端版）

DAFEIYU 是 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 的 SillyTavern 纯前端移植：一条 URL 安装扩展即可使用，不需要服务端插件、不需要修改 `config.yaml`、不需要另装伴身组件。小鲸鱼会在右下角显示 DeepSeek 余额与今日消耗，并保留拖拽、缩放、按压音效、随机台词、峰谷判定、右键菜单与移动端长按菜单。

## 安装与配置

SillyTavern → 扩展面板 → 「输入扩展程序的 Git URL 以安装」：

```
https://github.com/TOKEN-MONA/DAFEIYU
```

安装后刷新页面即用。扩展按 SillyTavern 1.12+ 的第三方扩展 ES Module 方式加载；已对照 1.12.14 的扩展加载器/DeepSeek 后端路径与 1.18.0 的后端路径做兼容检查。没有修改酒馆源码，因此不依赖特定服务端补丁。

- **消耗统计**：无需配置。扩展在前端截获酒馆聊天补全响应并统计 DeepSeek 用量。
- **余额显示**：在扩展面板「DeepSeek 余额小鲸鱼 (DAFEIYU)」填入你自己的 DeepSeek API Key。Key 只用于查询 `user/balance`，与正文模型连接相互独立。
- **API 地址**：默认 `https://api.deepseek.com`；如需中转，必须使用 `https://`。非官方域名保存前会展示 Key 将发往的完整地址并要求二次确认。

## 用量统计方式

DAFEIYU 会在浏览器 `fetch` 层识别正文 DeepSeek 请求：

1. 尽量在流式请求体中加入 `stream_options.include_usage`。部分 SillyTavern 后端会重建请求并丢弃该字段，因此这只是兼容性尝试，不是功能前提。
2. 克隆并解析后端转发回来的 JSON / SSE 响应；若响应携带 `usage`，按真实 token 数精确计价。
3. 若中转或酒馆版本剥离了 `usage`，则使用请求 prompt 与解析出的实际生成文本估算，金额带 `≈` 标识。
4. 标题生成、填表、记忆等后台请求拿到真实 DeepSeek `usage` 时静默入账；确认服务的是其他厂商模型时不入账。

估算使用酒馆 tokenizer（可用时），否则使用共享的 CJK/非 CJK 启发式。不要把估算值当作账单精确值；面板摘要中的「今日估算」显示估算轮数。

价格表基于 2026-09-12 的 DeepSeek 官方价格：Flash 缓存命中 0.02/0.04、缓存未命中 1/2、输出 4/8 元每百万 token（空闲/高峰），Pro 为 0.15/0.3、4.5/9、13.5/27。峰谷按北京时间计算，2026-08-23 起周末全天谷价。

## 用量模式

右键鲸鱼（触屏长按）可切换：

| 模式 | 说明 |
|---|---|
| **小鲸鱼记账（默认）** | 以余额下跌为主，同时保留实时统计作为跨天首次查询前的携带账本，减少“今日显示 0”的情况。需填 Key；未填 Key 时自动回落实时统计。 |
| **实时·精确 / 估算** | 直接使用响应 `usage` 或估算结果，每轮即时更新。 |

正文源非 DeepSeek 时小鲸鱼半暗、不自动查余额；点击可手动查一次。未填 Key 时显示 `--` 而不是无限加载。

## 兼容性与数据

- 不依赖 `STREAM_TOKEN_RECEIVED` 事件生成估算：输出文本直接从响应体解析，旧版酒馆事件不完整时仍可统计。
- 酒馆缺少生成事件时，DeepSeek 请求不再被误判为后台 quiet prompt。
- 数据存于本机浏览器 `localStorage`（`dafy-*` 键）。多标签页在支持 Web Locks 的浏览器中串行化账本写入；非安全上下文等旧环境退化为 best-effort。
- CSS/DOM 使用 `dafyv-*` 命名空间，可与旧 `dshwv-*` 双件版共存。
- 换浏览器/设备不共享数据；卸载扩展后可手动清理 `dafy-*` 键。

## 隐私与安全边界

- 不填 Key 时不持有任何密钥、不发余额请求。
- Key 不写入 `extensionSettings/settings.json`，不随酒馆备份/导出；以混淆形式存于本机 `localStorage`。
- 余额请求优先在独立 Worker 线程发出，降低常见页面包装脚本截获请求的机会；Worker 不可用时才回退页面 `fetch`。
- 纯前端扩展无法防御更早加载的恶意脚本、浏览器扩展或能读取本页数据的程序。混淆不是加密；绝对不落地明文需要服务端方案。

## 开发验证

```bash
node --test tests/*.test.mjs
node --check index.js widget.js core.js
```

测试覆盖当前价格表、北京时间峰谷、SSE/JSON 解析、跨天账本、余额账本携带、旧事件降级、右键菜单与 CSS 命名空间。

## 致谢与许可

- 原作：[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）
- SillyTavern 移植版 v0.2.10-st1 作者：TOKEN MONA
- DAFEIYU 前端主要制作/更新：DBSoH
- License：MIT，见 [LICENSE](LICENSE)；鲸鱼形象与音效素材版权归原作所有。
