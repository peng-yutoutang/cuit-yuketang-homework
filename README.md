# 雨课堂作业面板

把雨课堂（www.yuketang.cn / 长江 / 荷塘 / 黄河）里所有课程的**课后作业**汇总到一个本地网页：一眼看到当下待完成的作业、截止时间与状态，查看题目，并直接作答提交。

## 功能

- 按学期分组展示课程与作业，默认显示最新学期，可一键切换历史学期
- 状态一目了然：待完成、已逾期、已完成（含得分），课堂活动不会混入
- 作业列表支持三种排序：按截止日期、按发布日期、按完成分数
- 按状态 / 按课程筛选
- 作业题面（学习卡片图文）直接预览，图片经本地代理显示，不受防盗链影响；内嵌官方作答页里的题干图片同样自动走本地代理
- 兼容两类作业：卡片作业（`leaf_type=7`）与试卷作业（`leaf_type=9`），均能识别题目内容
- 三种作答方式：
  1. **在面板中作答**：打开作业即进入官方作答页（整站透明代理，交互与官网一致，作答后提交直接到达雨课堂）
  2. **在雨课堂窗口作答**：一键把专属浏览器窗口切到该作业并置前（手机视图）
  3. **浏览器新标签打开**：直接打开官方作答页

## 原理

- 用你本机的浏览器登录雨课堂：优先使用系统默认浏览器（Chrome / Edge / 360 / QQ 等 Chromium 内核浏览器均可），使用独立配置目录 `chrome-profile/`，登录态持久保存，不碰你的日常浏览器
- 本地 Node 服务通过浏览器调试协议（CDP）读取登录 Cookie，调用雨课堂官方网页使用的同一套接口
- 作答页通过本地反向代理同源嵌入，服务端代带 Cookie，并把受防盗链保护的题干图片改写为本地代理地址，不需要你自己导出 Cookie
- 所有数据只在你的电脑与雨课堂服务器之间流转，不上传任何第三方

## 快速开始

环境要求：Windows 10/11，并已安装 Node.js 22 或更高版本（建议到 [nodejs.org](https://nodejs.org/zh-cn) 安装最新 LTS 版）。

1. 双击 `start.bat`（或在项目目录运行 `npm start`）
2. 会弹出唯一一个专属浏览器窗口（优先使用系统默认浏览器），自动打开两个标签页：**雨课堂登录页**和 `http://localhost:8500` 作业面板；若未登录，用**手机微信扫一扫**登录页二维码，登录一次后重启也无需再扫
3. 面板会自动加载课程与作业，点击“刷新”可重新拉取

## 常用操作

- 打包发布：双击 `pack.bat`，会在项目目录生成 `雨课堂作业面板-发布.zip`（不含登录缓存、本地数据与日志，体积很小）；把 zip 发给他人后，对方需先完整解压、再双击 `start.bat`，且需自行安装 Node.js 22+
- 顶部“刷新”：重新拉取课程与作业
- 学期选择：顶部学期标签切换（默认最新学期）
- 排序：截止日期 / 发布日期 / 完成分数
- 状态筛选：全部 / 待完成 / 已逾期 / 已完成
- 课程筛选：只看某门课
- 设置：切换雨课堂服务器（默认 `www.yuketang.cn`）
- 停止：`stop.bat`（或 Ctrl+C 结束 Node 进程）；浏览器里的登录态会保留

## 已验证的雨课堂接口

- 课程列表：`GET /v2/api/web/courses/list?identity=2`
- 用户信息：`GET /api/v3/user/basic-info`
- 班级信息（sign / sku_id / uv_id）：`GET /v2/api/web/classrooms/{classroom_id}?role=5`
- 待办作业：`GET /c27/online_courseware/course/classroom/{classroom_id}/{sku_id}/todo_list/?client_type=h5&classroom_id={classroom_id}`（仅 `type=7` 为作业）
- 章节（作业叶子 `leaf_type=7/9`）：`GET /mooc-api/v1/lms/learn/course/chapter?...`
- 叶子真实内容 ID：`GET /mooc-api/v1/lms/learn/leaf_info/{classroom_id}/{leaf_id}/`（`content_info.leaf_type_id`）
- 完成状态与得分：`GET /mooc-api/v1/lms/learn/course/schedule?...`
- 作业详情：`GET /v/cards/learning_cards_detail/{id}`（标题/截止/状态）
- 作业正文：`GET /v/cards/cards_info/{id}/`（`data.cardData.Slides` 图文内容）
- 题目详情：`GET /v/cards/problem_detail/{id}/`（题干/选项/分数）
- 试卷作业：`GET /v/quiz/quiz_info/{id}/?pageIndex=1`（HTML 内嵌 base64 试卷数据）

接口需携带 `xtbz: ykt`、`university-id`、`uv-id` 请求头及登录 Cookie。

## 目录结构

- `server.js` — 本地 HTTP 服务、接口路由与反向代理
- `lib/cdp.js` — 浏览器调试协议（CDP）客户端
- `lib/yuketang.js` — 雨课堂接口封装
- `public/` — 前端页面
- `chrome-profile/` — 独立浏览器登录配置（首次启动自动创建，勿提交）
- `data/` — 本地配置

## 注意

- 本工具面向你自己的账号、只用于查看与完成你自己的作业；请遵守学校与雨课堂的使用规范，不要用于考试作弊
- 雨课堂是非公开接口，页面改版可能导致部分功能失效；面板内置网络抓包记录（`/api/capture`，默认关闭），便于快速适配
- 服务只监听 `127.0.0.1`，登录会话保存在专属浏览器配置中，不会泄露到局域网
- 系统默认浏览器若为 Firefox 等非 Chromium 内核，会因无法读取登录 Cookie 自动回退到已安装的 Chrome / Edge；Windows 自带的 Edge 即可满足要求，无需安装 Chrome
- 启动日志会写入 `server.log`，启动失败或发给他人后无法弹窗时，让对方把该文件发回排查
