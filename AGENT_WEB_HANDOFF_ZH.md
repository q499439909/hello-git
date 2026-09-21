# Data-Juicer Agent Web 同事接手文档

> 最后核对：2026-09-21
>
> 仓库：`D:\djyuanshi\data-juicer-agents`
>
> 当前 Git 基线：`e141528 feat: add web auth and model switching`
> 说明：当前工作区还包含尚未提交的前端界面和静态资源修订，正式交付前请记录最终提交 SHA。

## 1. 这套服务是什么

这是一个面向 Data-Juicer Agent 的单体 Web 服务：

- 后端使用 FastAPI，负责账号认证、Agent 会话、模型发现、SSE 流式响应、Run 和 Artifact 管理。
- Agent 使用 AgentScope 和 `DJSessionAgent`，通过自然语言生成、保存并执行 Data-Juicer Plan/Recipe。
- 前端使用 React、TypeScript 和 Vite，提供登录、项目/会话侧栏、聊天、模型切换、工具执行过程和项目输出预览。
- SQLite 保存用户、登录 Session、Agent Session、聊天记录、项目、Run 和 Artifact 元数据。
- 磁盘按用户、会话和 Run 隔离保存 Plan、Recipe、输出和日志。

生产构建后，FastAPI 同时提供 API 和 React 静态页面，不需要单独部署前端服务器。

## 2. 当前已有功能

### 2.1 账号与用户隔离

- 用户可在本平台注册、登录和退出，不依赖上层数据平台账号。
- 第一个注册账号自动成为管理员，其余账号默认为普通用户。
- 密码使用 scrypt 哈希保存，认证使用 HttpOnly Cookie 中的不透明令牌。
- 管理员 API 可以查询用户以及启用、禁用或删除账号状态。
- 项目、会话、消息、Run、Artifact 查询全部携带当前用户身份。
- 用户文件分别写入不同的 `users/<user_key>/` 目录。

当前属于应用层“简单用户隔离”，不是独立数据库、容器或操作系统级安全沙箱。

### 2.2 项目和会话

- 左侧按“项目 → 会话”展示。
- 点击“新会话”时，新会话进入当前选中的项目。
- 临时 `new:*` 会话在第一次发送消息后升级为后端正式 Session，避免左侧出现重复项。
- 第一条用户消息会成为会话标题。
- 会话、聊天消息和 Agent 状态保存在 SQLite。
- 后端重启后，可以使用原 `session_id` 恢复历史并继续对话。
- 后端是聊天记录的事实来源，浏览器 `localStorage` 不再承担权威持久化。

### 2.3 模型连接与切换

- 后端从 OpenAI 兼容服务的 `/models` 获取真实模型列表。
- Session 创建响应返回后端实际采用的模型。
- 同一个 Session 可以原地切换模型，`session_id` 不变。
- 切换时迁移 AgentScope memory 和会话业务状态。
- 每次实际切换后 `switch_revision` 增加。
- 生成过程中禁止切换，后端返回 `409`。
- 模型切换失败时继续保留原模型和上下文。

### 2.4 对话和工具执行

- 使用 SSE 返回增量文本，不在前端增加逐字动画。
- 支持停止当前生成。
- 支持 Markdown、GFM 表格、列表和代码块渲染。
- 展示可审计的 `tool_start`、`tool_end` 和执行结果，不展示完整思维链。
- 流式合并兼容增量片段和累计文本，避免重复前缀或回复被切开。

### 2.5 Plan、Recipe 和项目输出

- Agent 可以生成和保存 Plan、Recipe，并调用 Data-Juicer 执行。
- `apply_recipe` 或 `submit_ray_job` 成功后，当前 Run 会归档并扫描 Artifact。
- 支持 JSON、JSONL、Parquet、文本、图片等输出的预览或下载。
- 支持删除 Artifact。
- Web 私有工具绑定会把结果 `export_path` 安全地改写到当前用户、Session 和 Run 下。

### 2.6 当前未完成或有限制的功能

- 输入框的“+”附件按钮目前只读取并显示文件名，没有上传文件，也不会把文件交给 Agent。
- 当前推荐单 Worker 运行。SQLite 能恢复持久会话，但生成中的锁和实时 SSE 状态没有跨 Worker 协调。
- 没有完整的用户管理前端页面；管理员能力目前主要通过 API 使用。
- 没有找回密码、邮箱验证、审计后台、配额和文件保留策略。
- 该服务没有自动读取任意命名的 `.env` 文件。

## 3. 五分钟启动

### 3.1 进入正确的虚拟环境

必须进入之前安装 `core` 的同一个虚拟环境，否则依赖和 `dj-web` 命令可能安装到另一个 Python。

```powershell
Set-Location D:\djyuanshi\data-juicer-agents
.\.venv\Scripts\Activate.ps1

python -c "import sys; print(sys.executable)"
python -m pip install -e ".[core,web]"
```

如果确认该虚拟环境已经正确安装 `core`，也可以只补 Web 依赖：

```powershell
python -m pip install -e ".[web]"
```

### 3.2 配置模型服务

在启动 `dj-web` 的同一个 PowerShell 中设置：

```powershell
$env:DJA_OPENAI_BASE_URL = "https://你的OpenAI兼容服务地址/v1"
$env:DASHSCOPE_API_KEY = "替换为真实Key"
$env:DJA_SESSION_MODEL = "替换为默认模型ID"
$env:DJA_FLATTEN_TOOLS = "auto"
```

也可使用 `MODELSCOPE_API_TOKEN` 替代 `DASHSCOPE_API_KEY`。

不要把真实 Key 写入源码、前端、文档、Git 或随意命名的 `.env` 文件。程序不会自动加载 `新建 文本文档.env` 等文件。

### 3.3 选择固定的数据目录

```powershell
$platformHome = "D:\data-juicer-platform"
```

开发环境也可以选择仓库内的 `platform`，但不要使用 `.codex-runtime/user-isolation-preview` 作为正式数据目录。

### 3.4 初始化、检查和启动

```powershell
dj-web --home $platformHome init
dj-web --home $platformHome doctor
dj-web --home $platformHome serve --host 0.0.0.0 --port 8080
```

浏览器访问：

```text
http://127.0.0.1:8080
```

全新数据库第一次打开时进入注册页。注册的第一个账号是管理员。

`init` 可以重复执行，不会清空已有项目和文件；它会补齐目录和数据库结构。升级旧数据库前仍应先备份整个 Platform Home。

## 4. 前后端分离开发

日常修改 React 页面时，建议后端和 Vite 分开启动。

### 4.1 后端：8000 端口

```powershell
Set-Location D:\djyuanshi\data-juicer-agents
.\.venv\Scripts\Activate.ps1

$env:DJA_OPENAI_BASE_URL = "https://你的服务/v1"
$env:DASHSCOPE_API_KEY = "你的Key"
$env:DJ_AUTH_COOKIE_SECURE = "false"

dj-web --home "D:\data-juicer-platform" serve --host 127.0.0.1 --port 8000
```

### 4.2 前端：4173 端口

另开一个 PowerShell：

```powershell
Set-Location D:\djyuanshi\data-juicer-agents\web
npm ci
$env:VITE_API_PROXY_TARGET = "http://127.0.0.1:8000"
npm run dev -- --host 127.0.0.1
```

浏览器访问：

```text
http://127.0.0.1:4173
```

Vite 会把 `/api` 代理给 8000 端口，因此浏览器仍按同源方式携带认证 Cookie。

### 4.3 修改前端后的生产构建

```powershell
Set-Location D:\djyuanshi\data-juicer-agents\web
npm test
npm run build
```

构建结果由 `vite.config.ts` 直接写入：

```text
data_juicer_agents/web_platform/static/
```

构建会生成带内容哈希的 JS/CSS。部署时必须整体替换 `static/`，不能只复制 `index.html` 或单个 JS 文件。

## 5. 建议按这个顺序阅读代码

第一次接手不建议从 Agent 内部实现直接读起。按下面顺序更容易形成整体认识。

### 第一步：启动和配置

1. `pyproject.toml`：Python 依赖、`core`/`web` 可选依赖、`dj-web` 命令。
2. `data_juicer_agents/web_platform/cli.py`：`init`、`doctor`、`serve` 入口。
3. `data_juicer_agents/web_platform/settings.py`：Platform Home、静态目录和认证 Cookie 配置。

### 第二步：HTTP 入口

阅读 `data_juicer_agents/web_platform/api.py`：

- FastAPI 应用如何初始化；
- 哪些路由公开，哪些路由需要登录；
- 登录 Cookie 如何设置；
- Session、消息、模型和 Artifact API 如何连接业务层；
- React 静态页面如何由 FastAPI 托管。

### 第三步：账号和持久化

1. `auth.py`：用户名校验、scrypt 密码哈希、登录令牌和密码修改。
2. `catalog.py`：SQLite schema、用户、会话、消息、Run、Artifact 查询以及旧数据库迁移。
3. `storage.py`：安全的相对存储键，防止 `..` 或绝对路径逃出 Platform Home。

### 第四步：Agent 会话主链路

1. `agent_sessions.py`：创建/恢复 Web Session、SSE、模型切换、中断、消息落库和 Run 轮换。
2. `capabilities/session/orchestrator.py`：AgentScope Agent、模型客户端、持久事件循环、上下文和模型切换。
3. `capabilities/session/toolkit.py`：原生 Session 工具列表和 Tool Context。
4. `adapters/agentscope/tools.py`：把项目的 ToolSpec 转成 AgentScope 工具。

### 第五步：文件和 Artifact

1. `service.py`：用户目录、RunLayout、输出分类、Run 归档和 Artifact 服务。
2. `tool_binding.py`：只针对 Web 环境改写 `build_dataset_spec` 和 `plan_save` 的 `export_path`。
3. `runtime_adapter.py`：在 Platform 管理的 Run 中执行现有 Plan。

### 第六步：React 前端

1. `web/src/main.tsx`：登录/注册入口、当前用户和退出。
2. `web/src/App.tsx`：项目侧栏、会话、聊天、模型切换和 Composer 主界面。
3. `web/src/lib/auth-api.ts`：认证 API。
4. `web/src/lib/agent-api.ts`：Session、历史消息、SSE、切换模型和中断。
5. `web/src/lib/chat-events.ts`：流式文本和工具事件合并。
6. `web/src/lib/session-store.ts`：临时会话升级、会话合并与选中规则。
7. `web/src/ArtifactLibrary.tsx` 和 `artifact-api.ts`：项目输出列表、预览、下载和删除。
8. `web/src/ToolTrace.tsx`：工具调用过程展示。
9. `web/src/styles.css`：整套页面视觉样式。

## 6. 整体调用链

一次普通对话的链路如下：

```text
浏览器 App.tsx
  │
  ├─ POST /api/agent/sessions（第一次消息前创建正式 Session）
  │
  └─ POST /api/agent/sessions/{id}/messages
          │
          ▼
     api.py
          │ 当前 Cookie → current_user
          ▼
     AgentSessionRegistry.get/create
          │
          ├─ 从 SQLite 恢复 Agent 状态（需要时）
          ├─ 创建用户专属 RunLayout
          └─ WebSessionAgent / DJSessionAgent
                  │
                  ├─ 调用模型
                  ├─ 调用 Data-Juicer 工具
                  ├─ tool_binding 改写输出路径
                  └─ SSE 事件返回浏览器
          │
          ├─ 用户消息、工具事件、助手回复写入 SQLite
          ├─ Agent 持久状态写入 agent_sessions.state_json
          └─ 执行成功后归档 Run 和 Artifact
```

## 7. 数据库和文件目录

### 7.1 SQLite 表

`platform.db` 当前包含：

| 表 | 用途 |
| --- | --- |
| `users` | 用户、密码哈希、角色和状态 |
| `auth_sessions` | 登录 Cookie 对应的令牌哈希和过期时间 |
| `agent_sessions` | Agent Session、项目、模型、标题和序列化状态 |
| `chat_messages` | 用户、助手和工具消息 |
| `project_bindings` | 用户范围内的项目 |
| `runs` | 每次执行的状态、目录和错误 |
| `artifacts` | 输出文件的类型、相对路径和元数据 |

SQLite 开启外键、WAL 和 5 秒 busy timeout。

### 7.2 当前文件结构

```text
<platform-home>/
├─ platform.db
├─ backups/
└─ users/
   └─ <user_key>/
      └─ sessions/
         └─ <session_id>/
            └─ runs/
               └─ <run_id>/
                  ├─ plans/
                  ├─ recipes/
                  ├─ outputs/
                  │  ├─ records/
                  │  ├─ media/images/
                  │  └─ reports/
                  ├─ logs/
                  └─ .djx/
```

注意：

- Plan YAML 在 `plans/`。
- Recipe 在 `recipes/`。
- Plan 中的 `export_path` 是处理结果文件路径，不是 Plan 文件位置。
- JSONL、JSON 和 Parquet 结果当前写到 `outputs/records/`。
- 不要手工把用户提供的路径直接与 Platform Home 拼接，应继续通过 `RunLayout` 和 `LocalArtifactStore`。

## 8. 主要配置项

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DJ_PLATFORM_HOME` | `<仓库>/platform` | 平台数据库和用户文件根目录 |
| `DJ_WEB_STATIC_DIR` | 包内 `web_platform/static` | 覆盖前端静态目录 |
| `DJ_AUTH_COOKIE_NAME` | `dj_session` | 登录 Cookie 名称 |
| `DJ_AUTH_SESSION_DAYS` | `14` | 登录有效期 |
| `DJ_AUTH_COOKIE_SECURE` | `false` | HTTPS 生产环境应设为 `true` |
| `DJA_OPENAI_BASE_URL` | 代码默认地址 | OpenAI 兼容服务根地址 |
| `DASHSCOPE_API_KEY` | 无 | 模型服务 Key |
| `MODELSCOPE_API_TOKEN` | 无 | 可替代上面的 Key |
| `DJA_SESSION_MODEL` | 内置默认模型 | 默认 Session 模型 ID |
| `DJA_FLATTEN_TOOLS` | `auto` | 工具 JSON Schema 兼容模式 |
| `DJA_LLM_THINKING` | `true` | 是否向兼容模型请求 thinking |

`--home` 的优先级高于 `DJ_PLATFORM_HOME`。`init`、`doctor` 和 `serve` 必须使用同一个目录。

## 9. 主要 API

### 9.1 公开接口

```text
GET /api/dj/v1/health
```

### 9.2 认证接口

```text
POST  /api/auth/register
POST  /api/auth/login
POST  /api/auth/logout
GET   /api/auth/me
PATCH /api/auth/password
```

### 9.3 管理员接口

```text
GET   /api/admin/users
PATCH /api/admin/users/{user_id}/status
```

### 9.4 模型和 Agent

```text
GET    /api/llm/models
POST   /api/agent/sessions
GET    /api/agent/sessions
GET    /api/agent/sessions/{session_id}
GET    /api/agent/sessions/{session_id}/messages
PATCH  /api/agent/sessions/{session_id}/model
POST   /api/agent/sessions/{session_id}/messages
POST   /api/agent/sessions/{session_id}/interrupt
```

### 9.5 Project、Run 和 Artifact

```text
POST   /api/dj/v1/projects/{app_id}/initialize
POST   /api/dj/v1/projects/{app_id}/runs
POST   /api/dj/v1/runs/{run_id}/finalize
GET    /api/dj/v1/projects/{app_id}/artifacts
GET    /api/dj/v1/artifacts/{artifact_id}
GET    /api/dj/v1/artifacts/{artifact_id}/preview-descriptor
GET    /api/dj/v1/artifacts/{artifact_id}/json
GET    /api/dj/v1/artifacts/{artifact_id}/text
GET    /api/dj/v1/artifacts/{artifact_id}/records
GET    /api/dj/v1/artifacts/{artifact_id}/content
GET    /api/dj/v1/artifacts/{artifact_id}/download
GET    /api/dj/v1/artifacts/{artifact_id}/thumbnail
DELETE /api/dj/v1/artifacts/{artifact_id}
```

除健康检查和认证入口外，业务接口均依赖登录 Cookie。访问其他用户的资源应返回不存在或拒绝访问。

## 10. 常见开发任务应该改哪里

| 需求 | 优先查看 |
| --- | --- |
| 修改登录/注册页面 | `web/src/main.tsx`、`styles.css`、`auth-api.ts` |
| 修改侧栏或聊天页面 | `web/src/App.tsx`、`styles.css` |
| 修复回复重复、切分或工具轮次 | `chat-events.ts`、`agent-api.ts`、`agent_sessions.py` |
| 修改会话恢复和排序 | `session-store.ts`、`agent_sessions.py`、`catalog.py` |
| 修改账号规则 | `auth.py`、`catalog.py`、`api.py` |
| 增加管理员页面 | 新前端组件、`auth-api.ts`、现有 `/api/admin/*` |
| 修改模型列表或切换 | `api.py`、`agent_sessions.py`、`orchestrator.py` |
| 修改输出目录 | `service.py`、`tool_binding.py`、相关测试和设计文档 |
| 增加 Artifact 格式预览 | `service.py`、`api.py`、`artifact-api.ts`、`ArtifactLibrary.tsx` |
| 增加真正附件上传 | 前端 Composer、新上传 API、存储限制、会话关联和安全校验 |

## 11. 测试和发布前验证

### 11.1 后端测试

```powershell
Set-Location D:\djyuanshi\data-juicer-agents
.\.venv\Scripts\Activate.ps1
python -m pytest tests/test_session_agent.py tests/test_web_platform.py -q
```

本文更新时结果为：

```text
46 passed
```

### 11.2 前端测试和构建

```powershell
Set-Location D:\djyuanshi\data-juicer-agents\web
npm ci
npm test
npm run build
```

本文更新时结果为：

```text
4 个测试文件，17 passed
Vite 构建成功，2134 modules transformed
```

### 11.3 手工回归

至少验证：

1. 新数据库首次注册账号并登录。
2. 第二个账号看不到第一个账号的项目、会话和文件。
3. 当前项目点击“新会话”，会话只出现在当前项目下。
4. 第一条消息后不会出现两条重复会话。
5. SSE 回复连续完整，不丢前缀、不重复。
6. 刷新页面后历史消息仍在。
7. 重启后端后原 Session 可以重新打开并继续对话。
8. 在同一 Session 中切换模型，`session_id` 不变且上下文仍能回忆。
9. 生成过程中切换模型返回 `409`。
10. 执行任务后 Plan、Recipe 和输出进入正确目录。
11. 项目输出能够预览、下载和删除。
12. 浏览器请求的静态 JS/CSS 没有 `404`。

## 12. 部署和数据迁移注意事项

### 12.1 代码迁移

优先使用 Git 提交或 Wheel。若只能复制文件，后端相关模块和整个 `static/` 必须来自同一版本。详细清单见：

```text
docs/MODEL_SWITCH_MIGRATION_DEPLOYMENT_ZH.md
```

仅负责运行的服务器不需要 `web/` 源码和 Node.js，只需要已构建的 `data_juicer_agents/web_platform/static/`。

### 12.2 数据迁移

迁移 Platform Home 前：

1. 停止 `dj-web`。
2. 备份整个 Platform Home，而不是只复制正在写入的 `platform.db`。
3. 迁移后执行 `dj-web --home <目录> init` 和 `doctor`。
4. 使用同一个 `--home` 启动。

旧单用户数据库升级后，旧项目、Run 和 Artifact 会进入禁用的 `legacy` 系统用户，避免自动暴露给新注册账号。需要保留旧数据访问时，应先确定归属并编写一次性迁移，不要把所有旧数据直接公开。

### 12.3 生产要求

- HTTPS 环境设置 `DJ_AUTH_COOKIE_SECURE=true`。
- 反向代理保持前端和 API 同源并转发 Cookie。
- `/api/agent/` 关闭代理缓冲并延长 SSE 读取超时。
- 当前使用单 Worker。
- Key 只进入后端进程环境。
- 部署前备份数据库和 `users/`。
- 记录最终 Git SHA、Wheel 版本或制品校验值。

## 13. 最容易踩的坑

### 13.1 启动了错误的 Python

表现：`agentscope` 找不到、`dj-web` 行为仍是旧版或依赖安装成功但启动失败。

检查：

```powershell
Get-Command python
Get-Command dj-web
python -c "import sys, data_juicer_agents; print(sys.executable); print(data_juicer_agents.__file__)"
```

### 13.2 `--home` 不一致

`init`、`doctor` 和 `serve` 指向不同目录时，会像是账号、聊天和文件“消失”，实际上打开的是另一套数据库。

### 13.3 把预览目录当成正式目录

`.codex-runtime/user-isolation-preview` 是本地测试目录。Plan 中出现它，说明服务就是用这个 Platform Home 启动的，不是 `tool_binding.py` 随机选择了路径。

### 13.4 只改 `web/src` 没有构建

`dj-web` 生产页面读取的是 `data_juicer_agents/web_platform/static/`。修改源码后必须执行 `npm run build` 并重启或刷新页面。

### 13.5 只复制一个哈希静态文件

`static/index.html`、哈希 JS 和哈希 CSS 必须成套更新，否则页面会请求不存在或旧版本的资源。

### 13.6 误以为任意 `.env` 会自动生效

当前没有自动 dotenv 加载。必须把变量注入真正启动 `dj-web` 的进程。

### 13.7 随意修改 Plan 的绝对输出路径

Web 环境由 `tool_binding.py` 和 `RunLayout.export_file()` 把数据结果绑定到当前 Run 的 `outputs/records/`。不要绕过这层直接允许模型写任意绝对路径。

### 13.8 多 Worker

SQLite 数据虽然共享，但内存里的 Agent 实例、生成锁和 SSE 队列不共享。没有新增跨进程协调之前，不要直接配置多个 Uvicorn Worker。

### 13.9 把附件文件名当作上传成功

当前附件按钮没有上传链路。不要在此基础上假设后端已经能读取用户本地文件。

### 13.10 旧文档可能落后

历史迁移文档记录了各阶段问题，有些状态已经被后续实现替代。判断当前行为时，以代码、测试、本接手文档和最新部署文档为准。

## 14. 当前工作区状态

本文更新时，仓库不是干净状态，至少包含：

- 登录/注册页面样式和字段调整；
- 新构建的静态 JS/CSS 及旧哈希资源删除；
- 更新后的迁移部署文档；
- 本机 `.codex-runtime/`、`web/node_modules/` 等不应提交内容；
- 其他未跟踪评测文件和压缩包。

接手时先执行：

```powershell
git status --short
git diff --check
git diff
```

不要直接执行 `git add .`。应逐项确认并排除：

```text
.codex-runtime/
web/node_modules/
.venv/
真实 Key 和 .env
本机临时文件
无关压缩包
```

## 15. 相关文档

| 文档 | 用途 |
| --- | --- |
| `docs/MODEL_SWITCH_MIGRATION_DEPLOYMENT_ZH.md` | 当前完整迁移、部署、验收和回滚 |
| `docs/SIMPLE_USER_ISOLATION_DESIGN_ZH.md` | 简单用户隔离设计及目录约定 |
| `docs/AGENT_WEB_API_REFERENCE_ZH.md` | Agent Web API 参考；使用前注意与当前代码核对 |
| `docs/PLATFORM_ONLY_EXPORT_FIX_ZH.md` | Web 私有输出路径适配背景 |
| `docs/STREAM_FIX_MIGRATION_ZH.md` | 流式回复重复和切分问题背景 |
| `docs/TOOL_TRACE_MIGRATION_ZH.md` | 工具过程展示实现背景 |
| `web/README.md` | 前端工程说明；部分历史描述可能需要继续更新 |

## 16. 接手检查清单

- [ ] 能确认当前使用的 Python、`dj-web` 和包源码路径。
- [ ] 能用固定 Platform Home 启动服务。
- [ ] 能注册、登录和退出。
- [ ] 能解释 SQLite 表和 `users/<user_key>/sessions/...` 文件目录。
- [ ] 能从前端消息请求追到 `DJSessionAgent`，再追到 SSE 返回。
- [ ] 能解释 `tool_binding.py` 为什么只影响 Web 工具。
- [ ] 能完成一次模型发现、对话、模型切换和中断。
- [ ] 能完成一次 Plan/Recipe 执行并在项目输出中查看 Artifact。
- [ ] 能运行后端 46 项相关测试和前端 17 项测试。
- [ ] 知道修改前端后必须重新构建 `static/`。
- [ ] 知道附件按钮尚未上传文件。
- [ ] 知道当前不能直接扩成多 Worker。
- [ ] 知道数据库升级和部署前要备份整个 Platform Home。
- [ ] 提交前能区分业务改动与本机临时文件。
