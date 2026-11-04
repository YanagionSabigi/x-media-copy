# X 图文复制与媒体下载

Chrome 扩展，在 X 推文底部添加复制与 GIF 按钮。把原文、页面译文、原图和出处一起复制到聊天窗口或文档，也可以下载 MP4，或把视频和动图制作成 GIF。

当前版本 **1.2.2**：[下载安装包](https://github.com/YanagionSabigi/x-media-copy/releases/latest) · [使用细节](USAGE.md) · [更新记录](CHANGELOG.md)

## 安装

需要 Chrome 116 或以上版本，以及能正常访问 X 的网络环境。

1. 从 [Releases](https://github.com/YanagionSabigi/x-media-copy/releases/latest) 下载 `x-media-copy-1.2.2.zip`，解压到准备长期保留的文件夹。安装插件只需这个 ZIP；`upstream-sources` 归档供源码分发与构建使用。
2. 在 Chrome 地址栏输入 `chrome://extensions`，打开右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择直接包含 `manifest.json` 的文件夹。
4. 打开或刷新 `https://x.com/`、`https://twitter.com/` 页面。

更新时替换解压目录中的文件，在扩展管理页点击重新加载，再刷新已打开的 X 页面。插件包已附带 GIF 转换所需文件，安装时无需 Node.js。

## 使用

### 复制按钮

X 推文底部最右侧的复制按钮支持以下操作：

| 操作 | 复制内容 |
| --- | --- |
| 直接点击 | 原文、译文、各张原图与出处链接 |
| Alt + 点击 | 原文、各张原图与出处链接，省略译文 |
| Shift + 点击 | 原文、译文与出处链接，将静态图片合成一张 PNG |
| Alt + Shift + 点击 | 合图，同时省略译文 |

**复制成功后会自动给原帖点赞**，已点赞的帖子保持原状态。静态图片随文字写入剪贴板；视频下载为 MP4，X 动图按下面的瘦身档转换为 GIF 后下载。

译文取自 X 页面，插件不另行翻译。请等出现「已复制，可粘贴」后再切换窗口；译文未生成时，可先在 X 中展开翻译。复制时会清理正文和译文中的话题标签。

### GIF 按钮

带**视频或动图**的帖子，复制按钮左侧会有一个胶囊形的 **GIF** 按钮：

| 操作 | GIF 模式 | 转换设置 |
| --- | --- | --- |
| 直接点击 | 瘦身 GIF | 10 fps、宽度最多 480 px、128 色调色板预算；较窄视频不放大 |
| Alt + 点击 | 源视频 GIF | 保留源帧率和原尺寸，使用完整的 256 色调色板预算 |

**两种方式都复制原文、译文和出处链接，并自动点赞。** GIF 按钮上的 Alt 用来选择源视频模式，仍保留译文。复制成功后，点赞与下载任务并行进行；下载提交失败不会阻止点赞，已点赞的帖子保持原状态。

GIF 无音频、循环播放，保留视频时长，但受格式时间精度限制。GIF 文件下载后手动拖入聊天窗口；按钮不把动图写入剪贴板，也不同时下载 MP4 或复制静态附件。普通视频需要原始 MP4 时，点击复制按钮。

复制内容在译文与出处之间留一个空白行，供手动插入下载的 GIF：

```text
Original text

中文译文

https://x.com/example/status/1234567890
```

瘦身档会降低帧率、尺寸和颜色数量，适合聊天分享。源视频档保留更多帧和原尺寸，通常体积更大、转换更慢；GIF 的颜色和时间精度限制仍然存在。压缩效果取决于素材，参数对照见仓库中的 [调研与实测](https://github.com/YanagionSabigi/x-media-copy/blob/main/docs/ezgif-optimization-2117538582755729828.md)。

### 媒体下载内容

点击浏览器工具栏中的插件图标，可以查看进度、取消任务、重试或打开文件所在文件夹。文件默认保存在浏览器下载目录的 `X` 子目录，命名为 `<帖子编号>_<序号>.mp4` 或 `.gif`。

两种 GIF 模式分别去重、显示和重试，共用串行转换队列。没有取得视频地址时，请先播放原帖媒体，再点击帖子上的按钮。GIF 转换失败时，可以在任务中选择「下载原始 MP4」。

### 效果示例

![原贴](https://cdn.jsdelivr.net/gh/sabiko2/MyPic@main/C%3A%5CUsers%5C10166%5CDesktop%5C%E5%9B%BE%E7%89%87%E6%9A%82%E5%AD%98/20261022140358276.png)

*原贴*

![复制效果](https://cdn.jsdelivr.net/gh/sabiko2/MyPic@main/C%3A%5CUsers%5C10166%5CDesktop%5C%E5%9B%BE%E7%89%87%E6%9A%82%E5%AD%98/20261022140247411.png)

*复制效果*

## 常见问题

- **更新后按钮失效**：重新加载扩展后，还需要刷新 X 页面。
- **微信 / QQ 没有一起粘贴图片**：混合图文的接收方式取决于客户端。GIF 和视频下载后可拖入聊天窗口。
- **多图无法合成**：合图按附件顺序推断布局，图片尺寸不匹配或超过上限时会提示失败；可改用普通点击复制各张图片。
- **视频没有下载**：目前需要完整 MP4 地址，仅有 HLS 流时可用 [猫抓 Cat Catch](https://github.com/xifangczy/cat-catch) 等工具处理。

GIF 当前支持最长 60 秒、输入最多 128 MiB、单帧面积不超过 3840×2160 的视频，输出需小于 256 MiB，处理最多 10 分钟。详细限制、文字间距、合图规则及排查方法见 [使用细节](USAGE.md)。

## 隐私

图文提取、合图和 GIF 转换都在浏览器内完成，不上传媒体到转换网站，不含遥测，也不调用外部翻译 API。可见帖子的静态原图会限量预取，临时缓存在内存中，离开或隐藏页面时清理。权限和数据处理说明见 [PRIVACY.md](PRIVACY.md)。

## 开发与反馈

使用原生 JavaScript、Chrome Manifest V3 和 FFmpeg WASM，没有前端打包步骤。开发环境使用 Node.js 22 或以上版本，CI 使用 Node.js 22。

```sh
git clone https://github.com/YanagionSabigi/x-media-copy.git
cd x-media-copy
npm ci --ignore-scripts
npm test
```

开发时可直接加载仓库目录。运行 `npm run package` 生成插件 ZIP；同名 ZIP 已存在时会报错并保留旧包。依赖准备、浏览器测试和代码结构见 [开发与维护](USAGE.md#开发与维护)。

问题反馈请到 [Issues](https://github.com/YanagionSabigi/x-media-copy/issues)，附上扩展版本、浏览器版本、操作方式和复现步骤。欢迎通过 Pull Request 提交修改，并说明改动目的和验证结果。

## 许可证与来源

本项目原创代码采用 [GPL-3.0-or-later](LICENSE)，按现状提供，不附带担保。随包的 FFmpeg 及其他组件保留各自许可证，每个 Release 同时提供上游对应源码和校验和。

来源与分发说明见 [NOTICE.md](NOTICE.md)、[vendor/NOTICE.md](vendor/NOTICE.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。
