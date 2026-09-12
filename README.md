# DAFEIYU — DeepSeek 余额小鲸鱼

DAFEIYU 是 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 的酒馆插件版。只需通过扩展 URL 安装，不需要服务端、不需要修改酒馆配置文件。

小鲸鱼会显示 DeepSeek 余额和今日消耗，支持拖拽、缩放、音效、气泡台词、峰谷显示、右键菜单和移动端长按菜单。

## 安装

1. 打开 SillyTavern 的扩展面板。
2. 输入扩展 Git URL：

```
https://github.com/TOKEN-MONA/DAFEIYU
```

3. 安装后刷新页面。

适用 SillyTavern 1.12 及以上版本。

## 配置

### 消耗统计

无需配置。当前聊天连接使用 DeepSeek 时，会自动统计每轮消耗和今日累计。

### 余额显示

在扩展面板的「DeepSeek 余额小鲸鱼 (DAFEIYU)」中填入你自己的 DeepSeek API Key。

- Key 只用于查询余额。
- 与正文模型连接相互独立。
- 不填 Key 时，仍然可以查看消耗统计。
- API 地址默认为官方地址；使用中转时必须填写 `https://` 开头的地址。

## 使用说明

- 点击小鲸鱼：刷新余额。
- 右键小鲸鱼 / 移动端长按：打开设置菜单。
- 拖拽小鲸鱼：调整位置。
- 菜单中可调整大小、音量、气泡、用量模式和峰谷显示。
- 每轮对话结束：显示本轮消耗金额和 token 数，可在菜单中关闭。
- 余额暂时获取失败：保留上次显示的余额，稍后自动重试。

用量有两种模式：

| 模式 | 说明 |
|---|---|
| 小鲸鱼记账 | 根据余额变化统计今日消耗，需填写 Key。 |
| 实时统计 | 根据每轮返回的用量统计；拿不到精确用量时会显示带 `≈` 的估算值。 |

## 数据与隐私

- 所有本地数据只保存在当前浏览器中。
- API Key 不写入酒馆设置文件，也不随酒馆备份导出。
- 清除 Key 后，插件不会再发起余额请求。
- 更换浏览器或设备时，本地数据不会自动同步。

## 致谢与许可

- 原作：[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
- SillyTavern 移植版 v0.2.10-st1：TOKEN MONA
- 移植为酒馆插件版：DBSoH
- License：MIT，见 [LICENSE](LICENSE)；鲸鱼形象与音效素材版权归原作所有。
