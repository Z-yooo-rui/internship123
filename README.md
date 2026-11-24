# 腾讯 AI / 游戏 岗位

自动汇总腾讯在招的 **AI 方向**与**游戏方向**岗位（实习为主，应届可切换），部署在 GitHub Pages，每 2 小时自动更新。

数据来自腾讯校招官网公开接口，点击岗位卡片直达官网投递页。

---

## 本地预览

页面通过 `fetch` 读取同目录的 `data/jobs.json`，**不能直接双击打开 index.html**（浏览器会拦截本地文件请求）。起一个本地服务器：

```bash
cd 实习信息网页
python -m http.server 8000
```

然后打开 <http://127.0.0.1:8000>。

想重新抓一次数据：

```bash
python scripts/fetch_jobs.py              # 抓取并写入 data/jobs.json
python scripts/fetch_jobs.py --dry-run    # 只看统计，不写文件
```

只依赖 Python 3 标准库，不用装任何包。

---

## 部署到 GitHub Pages

### 1. 建仓库并推送

```bash
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

> 注意：部署工作流监听的是 `main` 分支。如果你用的分支名不是 main，要同步改 `.github/workflows/deploy-pages.yml`。

### 2. 打开 Pages

仓库 → **Settings** → **Pages** → **Source** 选 **GitHub Actions**。

不要选「Deploy from a branch」，那样不会输出站点，因为页面依赖 Actions 生成的数据。

### 3. 手动跑一次抓取

仓库 → **Actions** → 左侧选「抓取岗位数据」→ **Run workflow**。

跑完会生成 `data/jobs.json` 并自动提交。随后「部署到 GitHub Pages」会自动触发。

### 4. 访问

`https://<你的用户名>.github.io/<仓库名>/`

如果是 `<用户名>.github.io` 这种根仓库，地址就是 `https://<用户名>.github.io/`。

---

## 数据是怎么来的

```
GitHub Actions（每 2 小时，错峰在 23 分运行）
  └─ scripts/fetch_jobs.py
       ├─ 第 1 步：POST join.qq.com 列表接口，翻页拉全量（约 880 条）
       ├─ 第 2 步：逐个抓岗位详情，取 fid 子分类（4 并发 + 本地缓存，只抓新增）
       ├─ 按 config/families.json 映射成一级职能与二级细分
       ├─ 按 postId + 标题 + 城市 + 事业群 去重
       └─ 写入 data/jobs.json → 提交回仓库 → 触发 Pages 部署
```

两个关键点：

**腾讯列表接口没有 CORS 响应头**，浏览器无法直连，所以必须用 Actions 绕一圈。这也是页面不叫「实时」，而是「每 2 小时更新」的原因。

**分类来自腾讯官方，不是关键词猜的**。列表接口返回 `positionFamily`（一级职能：技术 / 产品 / 设计 / 市场 / 职能 / AI 研究），详情接口返回 `fid`（二级细分，如「算法研究」「游戏美术」「智能体 / 强化学习」）。脚本只做 ID 到名称的查表，不做语义判断。

---

## 怎么调分类

### 一级 / 二级职能：`config/families.json`

这张表是腾讯校招的官方分类树，照抄自接口字典。除非腾讯改分类，一般不用动。

```json
{
  "level1": { "2": "技术", "3": "产品", "4": "设计", "5": "市场", "6": "职能", "7": "AI 研究" },
  "level2": {
    "75": { "name": "软件开发", "parent": "2" },
    "753": { "name": "智能体 / 强化学习", "parent": "7" }
  }
}
```

### AI / 游戏 徽标：`config/rules.json`

这个只影响卡片左上角的彩色标记，不影响筛选。改法：

```json
{
  "ai": { "title_keywords": ["AI", "算法", "大模型", "..."] },
  "game": {
    "title_keywords": ["游戏", "引擎", "原画", "..."],
    "bg_keywords": ["IEG"],
    "bg_exclude_keywords": ["市场营销", "项目管理", "..."]
  }
}
```

- **英文关键词**用前后非英文字母的边界判定，`maintain` 不会命中 `AI`；中文是子串匹配
- `bg_keywords` 是兜底：IEG 的岗位即使标题没写「游戏」也标记为游戏方向
- `bg_exclude_keywords` 挡住 IEG 里的通用职能岗

> 早期版本用这套关键词决定「要不要展示岗位」，会误杀标题里没写 AI 的官方 AI 研究岗（实测漏了 104 条）。现在改成官方分类负责筛选、关键词只负责打标。

---

## 目录结构

```
├── index.html                 页面（单文件）
├── assets/
│   ├── app.js                 渲染与筛选逻辑
│   ├── style.css              手写样式，无构建
│   └── favicon.svg
├── data/
│   ├── jobs.json              岗位数据，由脚本生成，不要手改
│   └── detail-cache.json      详情缓存（postId → fid），由脚本维护
├── config/
│   ├── families.json          官方职能分类树（一级 + 二级）
│   └── rules.json             AI / 游戏 徽标关键词
├── scripts/fetch_jobs.py      抓取脚本
├── .github/workflows/
│   ├── update-jobs.yml        定时抓取
│   └── deploy-pages.yml       部署
└── 需求提示词.md               项目需求与实测结论
```

---

## 已知限制

- **「每 2 小时更新」不是实时**。GitHub 的定时调度在高负载时（尤其整点）会延迟甚至丢弃，所以 cron 刻意错峰到每 2 小时的 23 分。页面顶部显示的是数据实际的抓取时间
- **没有学历要求筛选**。腾讯校招的学历门槛写在招聘公告里，不在单个岗位的数据中。抽样 18 个岗位，只有 4 个 JD 提到学历（都是设计、职能岗），技术类、AI 研究类 JD 完全不写。硬做只能靠猜，所以不做
- 岗位列表来自校招接口，**不含社招**。社招在 `careers.tencent.com`，是另一套接口，当前没接
- 卡片上不显示 JD 正文。详情接口虽然能拿到 `desc` / `request`，但青云计划类岗位的正文是空的，展示出来会很割裂，暂不做
- 数据来自公开接口，如果腾讯改接口结构，脚本会报错退出（不会覆盖旧数据）。届时改 `scripts/fetch_jobs.py` 里的字段映射
