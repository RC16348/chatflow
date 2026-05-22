# ChatFlow

<p align="center">
  <img src="public/icon.png" width="120" alt="ChatFlow Logo">
</p>

<p align="center">
  <b>微信聊天记录分析工具</b> | <b>开源透明</b> | <b>本地处理</b>
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#安装使用">安装使用</a> •
  <a href="#构建指南">构建指南</a> •
  <a href="#技术架构">技术架构</a> •
  <a href="#开源协议">开源协议</a>
</p>

---

## 📖 项目简介

ChatFlow 是一款开源的微信聊天记录分析工具，支持查看、搜索、导出和分析微信聊天记录。所有数据处理均在本地完成，保护用户隐私。

**核心特点：**
- 🔒 **完全本地处理** - 聊天记录不会上传到任何服务器
- 📊 **强大的分析功能** - 年度报告、双人报告、群聊分析
- 🤖 **AI 助手** - 支持多种大语言模型，智能分析聊天记录
- 🚀 **防撤回** - 实时监测并记录撤回的消息
- 📱 **跨平台** - 支持 Windows、macOS、Linux

## ✨ 功能特性

### 基础功能
- [x] 微信聊天记录查看与搜索
- [x] 联系人管理
- [x] 朋友圈查看
- [x] 图片、视频、语音消息支持

### 导出功能
- [x] HTML 导出（保留样式和多媒体）
- [x] Word 导出
- [x] CSV 导出
- [x] 批量导出支持

### 分析功能
- [x] 年度聊天报告
- [x] 双人聊天报告
- [x] 群聊数据分析
- [x] 聊天词云
- [x] 消息热力图

### AI 功能
- [x] 智能聊天助手
- [x] 聊天记录总结
- [x] 情感分析
- [x] 支持 DeepSeek、OpenAI 等多种模型

### 高级功能
- [x] 消息防撤回通知
- [x] 语音转文字
- [x] 图片解密查看
- [x] 实时消息推送

## 📦 安装使用

### 下载预编译版本

前往 [Releases](https://github.com/RC16348/chatflow/releases) 页面下载对应平台的安装包。

> **注意**：目前仅在 Windows 10+ 平台上进行开发和测试，提供 Windows 版本的预编译安装包。

### 从源码构建

#### 环境要求

- **操作系统**: Windows 10 或更高版本
- **Node.js**: 18.0.0 或更高版本
- **Visual Studio Build Tools** 或 Visual Studio 2019+（用于编译原生模块）

#### 构建步骤

```bash
# 克隆仓库
git clone https://github.com/RC16348/chatflow.git
cd chatflow

# 安装依赖
npm install

# 开发模式运行
npm run dev

# 构建 Windows 版本
npm run build
```

> **说明**：本项目主要在 Windows 10+ 环境下开发和测试，其他平台的兼容性需要开发者自行验证和适配。

## 🏗️ 技术架构

### 技术栈

- **前端**: React 19 + TypeScript + Vite
- **桌面框架**: Electron
- **状态管理**: Zustand
- **样式**: SCSS
- **数据库**: SQLite (WCDB 解密)
- **构建**: electron-builder

### 项目结构

```
chatflow/
├── src/                    # 前端源码
│   ├── components/         # React 组件
│   ├── pages/             # 页面组件
│   ├── services/          # 业务服务
│   ├── stores/            # 状态管理
│   ├── utils/             # 工具函数
│   └── types/             # 类型定义
├── electron/              # Electron 主进程
│   ├── services/          # 主进程服务
│   ├── windows/           # 窗口管理
│   └── main.ts            # 入口文件
└── resources/             # 静态资源
```

### 核心模块

| 模块 | 说明 | 路径 |
|------|------|------|
| WCDB 解密 | 微信数据库解密核心 | `electron/services/wcdbService.ts` |
| 消息解析 | 微信消息格式解析 | `src/utils/messageParser.ts` |
| 导出服务 | 多格式导出实现 | `electron/services/exportService.ts` |
| AI Agent | 智能助手引擎 | `src/services/agent/` |

## 📄 开源协议

本项目采用 [CC BY-NC-SA 4.0](LICENSE)（知识共享 署名-非商业性使用-相同方式共享 4.0 国际版）协议开源。

### 授权范围

✅ **允许**
- 个人学习、研究使用
- 修改、二次开发
- 在非商业项目中使用
- 分享、传播本项目

❌ **禁止**
- 商业使用（包括但不限于销售、商业服务）
- 修改后闭源
- 更换协议后分发

## ⚠️ 免责声明

1. 本项目仅供学习研究使用，请遵守相关法律法规
2. 使用本工具产生的任何数据请妥善保管，避免泄露
3. 本项目与微信官方无关，微信是腾讯公司的注册商标
4. 请仅分析您拥有合法权限的聊天记录

## 🙏 致谢与参考

本项目在开发过程中参考和借鉴了以下优秀开源项目：

### 主要参考项目

- **[WeFlow](https://github.com/hicccc77/WeFlow)** - 一个本地的微信聊天记录导出和年度报告应用
  - 借鉴了其微信数据库解密和消息解析的实现思路
  - 参考了年度报告和聊天记录可视化的设计
  - 学习了其完全本地化的数据处理架构

- **[ChatLab](https://github.com/ChatLab/ChatLab)** - 本地优先的 AI 聊天记录分析工具
  - 借鉴了其 AI 助手与聊天记录结合的设计理念
  - 参考了多平台数据导入和标准化处理的思路
  - 学习了其隐私优先的本地数据处理方案

### 致谢说明

感谢以上项目的作者们为开源社区做出的贡献，为本项目提供了宝贵的技术参考和设计灵感。本项目在此基础上进行了二次开发和功能扩展，添加了更多个性化功能。

## 📞 联系方式

- 作者：luoka
- 邮箱：2803278835@qq.com
- 微信：luoka328

---

<p align="center">
  如果这个项目对你有帮助，请给个 ⭐ Star！
</p>
