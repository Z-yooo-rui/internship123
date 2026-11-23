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
GitHub Actions（每 2 小时）
  └─ scripts/fetch_jobs.py
       ├─ POST join.qq.com 公开接口，翻页拉全量（约 880 条）
       ├─ 按 config/rules.json 打 AI / 游戏标签
       ├─ 按 postId + 标题 + 城市 + 事业群 去重
       └─ 写入 data/jobs.json → 提交回仓库 → 触发 Pages 部署
```

腾讯那个接口**没有 CORS 响应头**，浏览器无法直连，所以必须这样绕一圈。这也是为什么页面不叫「实时」，而是「每 2 小时更新」。

---

## 怎么调分类规则

打开 `config/rules.json`，改完重新跑一次脚本即可，不用动代码。

```json
{
  "ai": {
    "title_keywords": ["AI", "算法", "大模型", "..."]
  },
  "game": {
    "title_keywords": ["游戏", "引擎", "原画", "..."],
    "bg_keywords": ["IEG"],
    "bg_exclude_keywords": ["市场营销", "项目管理", "..."]
  }
}
```

几个要点：

- **英文关键词**用前后非英文字母的边界判定，`maintain` 不会命中 `AI`；中文是子串匹配
- `bg_keywords` 是兜底：IEG（腾讯游戏事业群）的岗位即使标题没写「游戏」也算游戏岗
- `bg_exclude_keywords` 用来挡住 IEG 里的通用职能岗，避免「市场营销」被算成游戏岗
- 脚本每次运行都会打印命中统计。如果「未命中被丢弃」超过 80%，说明规则太窄，该补词了

---

## 目录结构

```
├── index.html                 页面（单文件）
├── assets/
│   ├── app.js                 渲染与筛选逻辑
│   ├── style.css              手写样式，无构建
│   └── favicon.svg
├── data/jobs.json             岗位数据，由脚本生成，不要手改
├── config/rules.json          分类规则
├── scripts/fetch_jobs.py      抓取脚本
├── .github/workflows/
│   ├── update-jobs.yml        定时抓取
│   └── deploy-pages.yml       部署
└── 需求提示词.md               项目需求与实测结论
```

---

## 已知限制

- **「每 2 小时更新」不是实时**。GitHub Actions 的定时任务在高峰期可能延迟十几分钟，页面顶部会显示实际更新时间
- 岗位列表来自校招接口，**不含社招**。社招在 `careers.tencent.com`，是另一套接口，当前没接
- 接口不返回 JD 正文，所以卡片上只有岗位名、事业群、城市、招聘项目。想看职责要点进官网
- 数据来自公开接口，如果腾讯改接口结构，脚本会报错退出（不会覆盖旧数据）。届时改 `scripts/fetch_jobs.py` 里的字段映射
