# 版权、上游项目与分发说明

Copyright (C) 2026 YanagionSabigi and contributors.

本项目原创代码采用 **GNU GPL-3.0-or-later**，完整条款见 [LICENSE](LICENSE)。第三方组件保留各自的版权、许可证和免责声明；本项目的许可证不改变这些原有许可。软件按现状提供，不附带担保。

| 上游 | 用途与关系 | 原有许可 |
| --- | --- | --- |
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)，`@ffmpeg/ffmpeg` 0.12.15 | 随包提供浏览器 JS API 和 worker；修改 `const.js` 的默认核心地址，改为扩展内资源，修改由 `scripts/vendor.cjs` 复现 | MIT，Copyright (c) 2019 Jerome Wu |
| 同项目的 `@ffmpeg/core` 0.12.10 | 随包提供未修改的单线程 FFmpeg JS/WASM 核心，在浏览器内将 MP4 转换为 GIF | GPL-2.0-or-later；包含的编解码库保留各自许可 |
| [FFmpeg](https://ffmpeg.org/) 5.1.4 与其编解码依赖 | WASM 核心的基础；构建启用了 `--enable-gpl` | GPL 及对应依赖的 GPL/LGPL/宽松许可，详见随包许可证与对应源码 |
| [猫抓 Cat Catch](https://github.com/xifangczy/cat-catch)，xifangczy 及贡献者 | **可选集成**：通过已安装扩展公开的消息接口尝试获取资源；未打包猫抓程序，也不要求先安装猫抓 | 上游 GPL v3，见 [上游 LICENSE](https://github.com/xifangczy/cat-catch/blob/master/LICENSE) |
| [RungeCC 的参考用户脚本](https://gist.github.com/RungeCC/753b2b9b7a7eefeac8a66fb6312277c5) | 图文复制交互的思路参考；本仓库不分发该用户脚本文件 | 原页面未明确授予开源许可，本项目不对该脚本重新授权 |

## 对应源码

`@ffmpeg/ffmpeg` 0.12.15 与 `@ffmpeg/core` 0.12.10 对应的上游提交均为
[`71aa99d37c02a7b4c435275ca9ef50e612f6efa1`](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/71aa99d37c02a7b4c435275ca9ef50e612f6efa1)。注意：旧的 `v0.12.10` 标签对应核心 0.12.6，并非本项目打包的核心版本。

每次发布在同一 [GitHub Releases](https://github.com/YanagionSabigi/x-media-copy/releases) 页面提供插件 ZIP、上游对应源码归档与校验和。源码归档保留各组件的源码、原有许可证，以及 FFmpeg WASM 的 Dockerfile、构建脚本和绑定代码；精确提交及文件哈希记录于 `vendor/source-manifest.json`。构建工具和环境说明随源码归档提供。

项目自身的可修改源码位于同一发布标签的仓库中；GitHub 自动生成的 Source code 归档也可下载。预编译核心直接取自锁定版本的 npm 包，没有重新编译或修改 WASM。源码获取和许可证详情见 [vendor/NOTICE.md](vendor/NOTICE.md)。

Cat Catch、FFmpeg、X、微信和 QQ 的名称及标识归各自权利人所有；列出这些名称只为说明兼容性和来源，不表示上游认可或背书本项目。
