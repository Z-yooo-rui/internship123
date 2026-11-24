#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
腾讯校招岗位抓取脚本

两步走：
1. 拉取岗位列表（约 880 条），只用列表接口，够做一级分类
2. 逐个抓岗位详情补齐子分类（fid），带本地缓存，只抓新增的

输出：
- data/jobs.json          页面数据
- data/detail-cache.json  详情缓存（postId -> fid），避免重复请求

只依赖 Python 标准库。用法：
    python scripts/fetch_jobs.py
    python scripts/fetch_jobs.py --dry-run
    python scripts/fetch_jobs.py --skip-details     # 只用缓存，不抓详情
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

LIST_API = "https://join.qq.com/api/v1/position/searchPosition"
DETAIL_API = "https://join.qq.com/api/v1/jobDetails/getJobDetailsByPostId?postId={post_id}"
PAGE_URL = "https://join.qq.com/post_detail.html?postid={post_id}"
REFERER = "https://join.qq.com/"
PAGE_SIZE = 100
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
CST = timezone(timedelta(hours=8))

# JD 正文分散在多个字段里，青云计划类岗位只有课题描述
TEXT_FIELDS = (
    "desc", "request", "graduateBonus", "internBonus",
    "introduction", "topicDetail", "topicRequirement",
)

EDU_ORDER = {"大专": 1, "本科": 2, "硕士": 3, "博士": 4}

MAJOR_GROUPS = {
    "计算机 / 软件": ["计算机", "软件工程", "软件", "人工智能", "数据科学", "信息安全", "网络工程"],
    "电子 / 通信": ["电子", "通信", "信号", "集成电路", "微电子", "自动化"],
    "设计 / 艺术": ["设计", "美术", "动画", "影视", "视觉", "交互", "艺术"],
    "数理 / 统计": ["数学", "统计", "物理", "运筹"],
    "金融 / 商科": ["金融", "经济", "会计", "财务", "供应链", "市场营销", "商业分析", "管理"],
    "人文 / 社科": ["法律", "法学", "政治学", "社会学", "心理", "新闻", "中文", "语言", "哲学"],
}

ROOT = Path(__file__).resolve().parent.parent
RULES_PATH = ROOT / "config" / "rules.json"
FAMILIES_PATH = ROOT / "config" / "families.json"
OUT_PATH = ROOT / "data" / "jobs.json"
CACHE_PATH = ROOT / "data" / "detail-cache.json"


def log(msg):
    print(msg, flush=True)


def load_json(path):
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def request_json(url, data=None, retries=3, timeout=30):
    headers = {
        "User-Agent": UA,
        "Referer": REFERER,
        "Accept": "application/json",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
        headers["Origin"] = REFERER.rstrip("/")
        payload = json.dumps(data).encode("utf-8")
        method = "POST"
    else:
        payload = None
        method = "GET"

    last_error = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, data=payload, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(2 * attempt)
    raise RuntimeError("请求失败: {} ({})".format(url, last_error))


# ---------- 列表 ----------

def fetch_page(page_index):
    body = request_json(
        LIST_API,
        data={"pageIndex": page_index, "pageSize": PAGE_SIZE, "language": "zh-cn"},
    )
    if body.get("status") != 0:
        raise RuntimeError(
            "列表接口返回异常: status={} msg={}".format(body.get("status"), body.get("message"))
        )
    return body.get("data") or {}


def fetch_all(max_pages=None):
    first = fetch_page(1)
    total = int(first.get("count") or 0)
    items = list(first.get("positionList") or [])
    total_pages = (total + PAGE_SIZE - 1) // PAGE_SIZE if total else 1
    if max_pages:
        total_pages = min(total_pages, max_pages)

    log("列表接口报告 {} 条，共 {} 页".format(total, total_pages))
    for idx in range(2, total_pages + 1):
        data = fetch_page(idx)
        batch = data.get("positionList") or []
        items.extend(batch)
        log("  第 {}/{} 页 +{} 条".format(idx, total_pages, len(batch)))
        time.sleep(0.35)
    return items, total


# ---------- 详情缓存 ----------

def load_cache():
    """缓存条目形如 {postId: {fid, edu, majors, enriched}}。兼容旧版纯 fid 整数。"""
    if not CACHE_PATH.exists():
        return {}
    try:
        raw = load_json(CACHE_PATH)
    except (json.JSONDecodeError, OSError):
        return {}

    out = {}
    for k, v in (raw.get("map") or {}).items():
        pid = str(k)
        if isinstance(v, dict):
            out[pid] = v
        else:
            try:
                out[pid] = {"fid": int(v)}
            except (TypeError, ValueError):
                continue
    return out


def save_cache(cache):
    payload = {
        "version": 2,
        "updated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "map": dict(sorted(cache.items())),
    }
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CACHE_PATH.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")


def extract_edu(text):
    """取最低学历门槛。『本科及以上』『博士/硕士』都按最低那一档算。"""
    if not text:
        return None
    found = set()
    if "博士" in text:
        found.add("博士")
    if "硕士" in text or "研究生" in text:
        found.add("硕士")
    if "本科" in text:
        found.add("本科")
    if "大专" in text or "专科" in text:
        found.add("大专")
    if not found:
        return None
    return min(found, key=lambda x: EDU_ORDER[x])


def extract_majors(text):
    """
    只在「专业」二字前后取窗口匹配，避免『确保内容兼具专业性』这类噪音。
    命中多个学科归并返回；明确写「专业不限」直接返回 ['不限']。
    """
    if not text:
        return []
    if re.search(r"专业不限|不限专业|无专业限制|不限学科", text):
        return ["不限"]

    hits = set()
    for m in re.finditer("专业", text):
        window = text[max(0, m.start() - 32): m.end() + 12]
        for group, kws in MAJOR_GROUPS.items():
            if any(kw in window for kw in kws):
                hits.add(group)
    return sorted(hits)


def fetch_detail(post_id, retries=2):
    url = DETAIL_API.format(post_id=post_id)
    try:
        body = request_json(url, retries=retries, timeout=25)
    except RuntimeError:
        return None
    if body.get("status") != 0:
        return None

    data = body.get("data") or {}
    fid = data.get("fid")
    try:
        fid = int(fid) if fid not in (None, "", 0) else None
    except (TypeError, ValueError):
        fid = None

    text = " ".join(str(data.get(k) or "") for k in TEXT_FIELDS)
    return {
        "fid": fid,
        "edu": extract_edu(text),
        "majors": extract_majors(text),
        "enriched": True,
    }


def enrich_details(items, cache, workers=4):
    """并发抓详情。旧格式缓存（只有 fid）也会重新补抓一次。"""
    missing = [
        it for it in items
        if not (cache.get(str(it.get("postId"))) or {}).get("enriched")
    ]
    total = len(missing)
    if not total:
        log("详情缓存已完整覆盖，跳过抓取")
        return cache, 0, 0

    log("需补抓详情 {} 条（缓存已有 {} 条），{} 并发".format(total, len(cache), workers))
    ok = fail = 0

    def task(item):
        pid = str(item.get("postId"))
        return pid, fetch_detail(pid)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(task, it) for it in missing]
        for idx, fut in enumerate(as_completed(futures), 1):
            try:
                pid, detail = fut.result()
            except Exception:
                fail += 1
                continue
            if detail:
                cache[pid] = detail
                ok += 1
            else:
                fail += 1
            if idx % 100 == 0 or idx == total:
                log("  详情 {}/{}（成功 {} 失败 {}）".format(idx, total, ok, fail))
            if idx % 300 == 0:
                save_cache(cache)
                log("  已落盘缓存 {}".format(len(cache)))

    return cache, ok, fail
    return cache, ok, fail


# ---------- 分类 ----------

def match_keyword(title, keyword):
    if keyword.isascii():
        pattern = r"(?<![A-Za-z]){}(?![A-Za-z])".format(re.escape(keyword))
        return re.search(pattern, title, re.IGNORECASE) is not None
    return keyword in title


def classify(title, bgs, rules):
    """方向徽标 ai / game。只用于卡片标记，不再作为主要筛选维度。"""
    tags = []
    if any(match_keyword(title, kw) for kw in rules["ai"]["title_keywords"]):
        tags.append("ai")

    game_cfg = rules["game"]
    if any(match_keyword(title, kw) for kw in game_cfg["title_keywords"]):
        tags.append("game")
    else:
        hit_bg = any(bg in game_cfg["bg_keywords"] for bg in bgs)
        excluded = any(
            match_keyword(title, kw) for kw in game_cfg.get("bg_exclude_keywords", [])
        )
        if hit_bg and not excluded:
            tags.append("game")
    return tags


def build_jobs(raw_items, rules, families, cache):
    intern_projects = set(rules["recruit_types"]["intern"])
    campus_projects = set(rules["recruit_types"]["campus"])
    project_counter = {}
    skipped = 0
    unmapped = 0
    jobs = []

    for raw in raw_items:
        title = (raw.get("positionTitle") or "").strip()
        post_id = str(raw.get("postId") or "").strip()
        if not title or not post_id:
            skipped += 1
            continue

        project = (raw.get("projectName") or "").strip()
        if project in intern_projects:
            recruit_type = "intern"
        elif project in campus_projects:
            recruit_type = "campus"
        else:
            recruit_type = "other"

        project_counter[project] = project_counter.get(project, 0) + 1

        bgs = [b for b in (raw.get("bgs") or "").split() if b]
        cities = [c for c in (raw.get("workCities") or "").split() if c]
        if not cities:
            cities = ["未标注"]

        tags = classify(title, bgs, rules)

        family_id = str(raw.get("positionFamily") or "")
        family = families["level1"].get(family_id)

        entry = cache.get(post_id) or {}
        fid = entry.get("fid")
        level2 = families["level2"].get(str(fid)) if fid else None
        sub_family = level2.get("name") if level2 else None
        if fid and not sub_family:
            unmapped += 1

        jobs.append(
            {
                "id": post_id,
                "title": title,
                "project": project,
                "label": (raw.get("recruitLabelName") or "").strip(),
                "type": recruit_type,
                "bgs": bgs,
                "cities": cities,
                "fid": fid,
                "familyId": family_id,
                "family": family,
                "subFamily": sub_family,
                "edu": entry.get("edu"),
                "majors": entry.get("majors") or [],
                "tags": tags,
                "url": PAGE_URL.format(post_id=post_id),
            }
        )

    if skipped:
        log("警告: {} 条记录缺少 title 或 postId，已跳过".format(skipped))
    if unmapped:
        log("提示: {} 条职位的 fid 不在映射表内，子分类留空".format(unmapped))
    return jobs, project_counter


def dedupe(jobs):
    merged = {}
    dup = 0
    for job in jobs:
        key = (
            job["title"],
            job["project"],
            tuple(sorted(job["cities"])),
            tuple(sorted(job["bgs"])),
        )
        if key in merged:
            dup += 1
            if job["id"] > merged[key]["id"]:
                merged[key] = job
            continue
        merged[key] = job
    return list(merged.values()), dup


def sort_jobs(jobs):
    type_rank = {"intern": 0, "campus": 1, "other": 2}
    family_rank = {"技术": 0, "AI 研究": 1, "产品": 2, "设计": 3, "市场": 4, "职能": 5}

    def key(job):
        try:
            neg_id = -int(job["id"])
        except (TypeError, ValueError):
            neg_id = 0
        return (type_rank.get(job["type"], 9), family_rank.get(job["family"], 8), neg_id)

    return sorted(jobs, key=key)


def build_meta(jobs, source_total, raw_total, project_counter, dup, cache, detail_ok, detail_fail):
    now = datetime.now(CST)
    family_counter = {}
    sub_counter = {}
    city_counter = {}
    bg_counter = {}
    edu_counter = {}
    major_counter = {}

    for job in jobs:
        if job["family"]:
            family_counter[job["family"]] = family_counter.get(job["family"], 0) + 1
        if job["subFamily"]:
            sub_counter[job["subFamily"]] = sub_counter.get(job["subFamily"], 0) + 1
        if job.get("edu"):
            edu_counter[job["edu"]] = edu_counter.get(job["edu"], 0) + 1
        for m in (job.get("majors") or []):
            major_counter[m] = major_counter.get(m, 0) + 1
        for city in job["cities"]:
            city_counter[city] = city_counter.get(city, 0) + 1
        for bg in job["bgs"]:
            bg_counter[bg] = bg_counter.get(bg, 0) + 1

    with_sub = sum(1 for j in jobs if j["subFamily"])
    with_edu = sum(1 for j in jobs if j.get("edu"))
    with_major = sum(1 for j in jobs if j.get("majors"))

    return {
        "fetched_at": now.isoformat(timespec="seconds"),
        "fetched_at_display": now.strftime("%Y-%m-%d %H:%M"),
        "source_total": raw_total,
        "source_count": source_total,
        "kept_count": len(jobs),
        "intern_count": sum(1 for j in jobs if j["type"] == "intern"),
        "campus_count": sum(1 for j in jobs if j["type"] == "campus"),
        "ai_count": sum(1 for j in jobs if "ai" in j["tags"]),
        "game_count": sum(1 for j in jobs if "game" in j["tags"]),
        "both_count": sum(1 for j in jobs if len(j["tags"]) == 2),
        "dropped_count": source_total - len(jobs),
        "merged_duplicates": dup,
        "detail_cache_total": len(cache),
        "detail_fetched": detail_ok,
        "detail_failed": detail_fail,
        "subfamily_coverage": round(with_sub / len(jobs), 3) if jobs else 0,
        "edu_coverage": round(with_edu / len(jobs), 3) if jobs else 0,
        "major_coverage": round(with_major / len(jobs), 3) if jobs else 0,
        "families": [
            {"name": k, "count": v}
            for k, v in sorted(family_counter.items(), key=lambda kv: -kv[1])
        ],
        "subFamilies": [
            {"name": k, "count": v}
            for k, v in sorted(sub_counter.items(), key=lambda kv: -kv[1])
        ],
        "edus": [
            {"name": k, "count": v}
            for k, v in sorted(edu_counter.items(), key=lambda kv: EDU_ORDER.get(kv[0], 9))
        ],
        "majors": [
            {"name": k, "count": v}
            for k, v in sorted(major_counter.items(), key=lambda kv: -kv[1])
        ],
        "projects": dict(sorted(project_counter.items(), key=lambda kv: -kv[1])),
        "cities": [
            {"name": k, "count": v}
            for k, v in sorted(city_counter.items(), key=lambda kv: -kv[1])
        ],
        "bgs": [
            {"name": k, "count": v}
            for k, v in sorted(bg_counter.items(), key=lambda kv: -kv[1])
        ],
    }


def signature(jobs):
    """用于判断内容是否变化。用 get 兼容旧格式数据。"""
    return [
        (
            j.get("id"), j.get("title"), j.get("type"), j.get("fid"),
            j.get("edu"), tuple(j.get("majors") or []), tuple(j.get("tags") or []),
        )
        for j in jobs
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只抓取统计，不写文件")
    parser.add_argument("--max-pages", type=int, default=None, help="限制列表页数，调试用")
    parser.add_argument("--skip-details", action="store_true", help="只用缓存，不抓详情")
    args = parser.parse_args()

    rules = load_json(RULES_PATH)
    families = load_json(FAMILIES_PATH)
    cache = load_cache()

    log("加载详情缓存: {} 条".format(len(cache)))
    raw_items, raw_total = fetch_all(max_pages=args.max_pages)
    log("实收 {} 条列表记录".format(len(raw_items)))

    detail_ok = detail_fail = 0
    if args.skip_details:
        log("--skip-details 已启用，跳过详情抓取")
    else:
        cache, detail_ok, detail_fail = enrich_details(raw_items, cache)

    jobs, project_counter = build_jobs(raw_items, rules, families, cache)
    before = len(jobs)
    jobs, dup = dedupe(jobs)
    jobs = sort_jobs(jobs)
    meta = build_meta(
        jobs, len(raw_items), raw_total, project_counter, dup, cache, detail_ok, detail_fail
    )

    log("")
    log("===== 结果 =====")
    log("列表记录      : {}".format(len(raw_items)))
    log("打标后        : {} → 去重后 {}".format(before, len(jobs)))
    log("实习 / 应届   : {} / {}".format(meta["intern_count"], meta["campus_count"]))
    log("AI / 游戏徽标 : {} / {}（重叠 {}）".format(
        meta["ai_count"], meta["game_count"], meta["both_count"]))
    log("子分类覆盖率  : {:.0%}".format(meta["subfamily_coverage"]))
    log("学历覆盖率    : {:.0%}  {}".format(
        meta["edu_coverage"],
        "，".join("{}({})".format(e["name"], e["count"]) for e in meta["edus"]) or "无"))
    log("专业覆盖率    : {:.0%}  {}".format(
        meta["major_coverage"],
        "，".join("{}({})".format(m["name"], m["count"]) for m in meta["majors"]) or "无"))
    log("一级分类      : {}".format(
        "，".join("{}({})".format(f["name"], f["count"]) for f in meta["families"])))
    log("")
    log("AI 研究方向细分:")
    ai_names = {
        "大语言模型 / NLP", "多模态 / 视觉 / 语音", "智能体 / 强化学习",
        "搜索 / 推荐 / 模型应用", "AI 基础设施 / 系统与安全",
        "AI 数据 / 数据工程", "AI 其他方向",
    }
    for item in meta["subFamilies"]:
        if item["name"] in ai_names:
            log("  {:<26} {}".format(item["name"], item["count"]))

    payload = {"meta": meta, "jobs": jobs}

    if args.dry_run:
        log("")
        log("--dry-run：未写入任何文件")
        return 0

    save_cache(cache)
    log("")
    log("缓存已更新: {}".format(CACHE_PATH))

    if OUT_PATH.exists():
        try:
            previous = load_json(OUT_PATH)
            if signature(previous.get("jobs") or []) == signature(jobs):
                log("岗位内容无变化，跳过写入 jobs.json")
                return 0
        except (json.JSONDecodeError, OSError):
            pass

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    log("已写入 {} ({:.1f} KB)".format(OUT_PATH, OUT_PATH.stat().st_size / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
