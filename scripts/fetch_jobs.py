#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
腾讯校招岗位抓取脚本

从 join.qq.com 公开接口拉取全量在招岗位，打 AI / 游戏 标签，去重后
输出 data/jobs.json 供静态页面读取。

只依赖 Python 标准库。用法：
    python scripts/fetch_jobs.py              # 正常抓取并写文件
    python scripts/fetch_jobs.py --dry-run    # 只统计，不写文件
    python scripts/fetch_jobs.py --max-pages 2

设计要点：
- 幂等：数据无变化时不写文件，避免 Actions 产生空 commit
- 容错：接口失败直接退出非零码，不动已有数据文件
- 可观测：输出分类命中统计，便于判断规则是否太窄
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://join.qq.com/api/v1/position/searchPosition"
DETAIL_URL = "https://join.qq.com/post_detail.html?postid={post_id}"
REFERER = "https://join.qq.com/"
PAGE_SIZE = 100
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
CST = timezone(timedelta(hours=8))

ROOT = Path(__file__).resolve().parent.parent
RULES_PATH = ROOT / "config" / "rules.json"
OUT_PATH = ROOT / "data" / "jobs.json"


def log(msg):
    print(msg, flush=True)


def load_rules():
    with RULES_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


def fetch_page(page_index, retries=3):
    payload = json.dumps(
        {"pageIndex": page_index, "pageSize": PAGE_SIZE, "language": "zh-cn"}
    ).encode("utf-8")
    req = urllib.request.Request(
        API,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Referer": REFERER,
            "Origin": REFERER.rstrip("/"),
        },
        method="POST",
    )

    last_error = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            if body.get("status") != 0:
                raise RuntimeError(
                    "接口返回异常: status={} message={}".format(
                        body.get("status"), body.get("message")
                    )
                )
            return body.get("data") or {}
        except (urllib.error.URLError, TimeoutError, ValueError, RuntimeError) as exc:
            last_error = exc
            if attempt < retries:
                wait = 2 * attempt
                log("  第 {} 页第 {} 次失败，{} 秒后重试: {}".format(page_index, attempt, wait, exc))
                time.sleep(wait)
    raise RuntimeError("第 {} 页连续失败: {}".format(page_index, last_error))


def fetch_all(max_pages=None):
    first = fetch_page(1)
    total = int(first.get("count") or 0)
    items = list(first.get("positionList") or [])
    total_pages = (total + PAGE_SIZE - 1) // PAGE_SIZE if total else 1
    if max_pages:
        total_pages = min(total_pages, max_pages)

    log("接口报告共 {} 条岗位，分 {} 页拉取".format(total, total_pages))
    for idx in range(2, total_pages + 1):
        data = fetch_page(idx)
        batch = data.get("positionList") or []
        items.extend(batch)
        log("  第 {}/{} 页: +{} 条".format(idx, total_pages, len(batch)))
        time.sleep(0.4)
    return items, total


def match_keyword(title, keyword):
    """
    英文关键词加字母边界，避免 maintain → ai 这类误命中。
    中文关键词直接子串匹配。
    """
    if keyword.isascii():
        pattern = r"(?<![A-Za-z]){}(?![A-Za-z])".format(re.escape(keyword))
        return re.search(pattern, title, re.IGNORECASE) is not None
    return keyword in title


def classify(title, bgs, rules):
    """
    标题强命中优先。仅靠事业群命中（如 IEG）时，排除泛职能岗，
    避免「市场营销」「项目管理」这类岗位被算成游戏岗。
    """
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


def build_jobs(raw_items, rules):
    intern_projects = set(rules["recruit_types"]["intern"])
    campus_projects = set(rules["recruit_types"]["campus"])
    project_counter = {}
    skipped_no_key = 0
    jobs = []

    for raw in raw_items:
        title = (raw.get("positionTitle") or "").strip()
        post_id = str(raw.get("postId") or "").strip()
        if not title or not post_id:
            skipped_no_key += 1
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
        tags = classify(title, bgs, rules)

        if not tags:
            continue

        jobs.append(
            {
                "id": post_id,
                "title": title,
                "project": project,
                "label": (raw.get("recruitLabelName") or "").strip(),
                "type": recruit_type,
                "bgs": bgs,
                "cities": cities,
                "tags": tags,
                "url": DETAIL_URL.format(post_id=post_id),
            }
        )

    if skipped_no_key:
        log("警告: {} 条记录缺少 title 或 postId，已跳过".format(skipped_no_key))
    return jobs, project_counter


def dedupe(jobs):
    """
    同一岗位在多事业群/多城市重复发布时合并，保留信息更全的一条。
    判定依据：标题 + 招聘项目 + 城市集合 + 事业群集合 完全相同。
    """
    merged = {}
    merged_count = 0
    for job in jobs:
        key = (
            job["title"],
            job["project"],
            tuple(sorted(job["cities"])),
            tuple(sorted(job["bgs"])),
        )
        if key in merged:
            merged_count += 1
            keep = merged[key]
            # 保留 postId 更大的一条（雪花 ID，更大即更新）
            if job["id"] > keep["id"]:
                merged[key] = job
            continue
        merged[key] = job
    return list(merged.values()), merged_count


def sort_jobs(jobs):
    """实习在前、应届在后；同组内按 postId 降序（雪花 ID 越大越新）。"""
    type_rank = {"intern": 0, "campus": 1, "other": 2}
    return sorted(jobs, key=lambda j: (type_rank.get(j["type"], 9), _neg_id(j["id"])))


def _neg_id(post_id):
    # 用补零技巧让降序排序在纯 key 函数下可用
    try:
        return -int(post_id)
    except ValueError:
        return 0


def build_meta(jobs, source_count, raw_total, project_counter, merged_count):
    now = datetime.now(CST)
    ai_count = sum(1 for j in jobs if "ai" in j["tags"])
    game_count = sum(1 for j in jobs if "game" in j["tags"])
    both_count = sum(1 for j in jobs if len(j["tags"]) == 2)

    city_counter = {}
    bg_counter = {}
    for job in jobs:
        for city in job["cities"]:
            city_counter[city] = city_counter.get(city, 0) + 1
        for bg in job["bgs"]:
            bg_counter[bg] = bg_counter.get(bg, 0) + 1

    return {
        "fetched_at": now.isoformat(timespec="seconds"),
        "fetched_at_display": now.strftime("%Y-%m-%d %H:%M"),
        "source_total": raw_total,
        "source_count": source_count,
        "kept_count": len(jobs),
        "intern_count": sum(1 for j in jobs if j["type"] == "intern"),
        "campus_count": sum(1 for j in jobs if j["type"] == "campus"),
        "ai_count": ai_count,
        "game_count": game_count,
        "both_count": both_count,
        "dropped_count": source_count - len(jobs),
        "merged_duplicates": merged_count,
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


def content_signature(jobs):
    return [(j["id"], j["title"], j["type"], tuple(j["tags"])) for j in jobs]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只抓取统计，不写文件")
    parser.add_argument("--max-pages", type=int, default=None, help="限制抓取页数，调试用")
    args = parser.parse_args()

    rules = load_rules()
    log("开始抓取: {}".format(API))

    raw_items, raw_total = fetch_all(max_pages=args.max_pages)
    log("实收 {} 条原始记录".format(len(raw_items)))

    jobs, project_counter = build_jobs(raw_items, rules)
    before_dedupe = len(jobs)
    jobs, merged_count = dedupe(jobs)
    jobs = sort_jobs(jobs)

    meta = build_meta(jobs, len(raw_items), raw_total, project_counter, merged_count)

    log("")
    log("===== 抓取结果 =====")
    log("原始记录      : {}".format(len(raw_items)))
    log("招聘项目分布  : {}".format(json.dumps(project_counter, ensure_ascii=False)))
    log("打标后        : {}".format(before_dedupe))
    log("合并重复      : {}".format(merged_count))
    log("最终保留      : {}".format(len(jobs)))
    log("  AI 方向     : {}".format(meta["ai_count"]))
    log("  游戏方向    : {}".format(meta["game_count"]))
    log("  双标签      : {}".format(meta["both_count"]))
    log("  实习 / 应届 : {} / {}".format(meta["intern_count"], meta["campus_count"]))
    dropped_ratio = meta["dropped_count"] / meta["source_count"] if meta["source_count"] else 0
    log("未命中被丢弃  : {} ({:.1%})".format(meta["dropped_count"], dropped_ratio))
    if dropped_ratio > 0.8:
        log("警告: 丢弃比例超过 80%，分类规则可能过窄，建议检查 config/rules.json")

    payload = {"meta": meta, "jobs": jobs}

    if args.dry_run:
        log("")
        log("--dry-run 模式，未写入文件")
        return 0

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    if OUT_PATH.exists():
        try:
            with OUT_PATH.open(encoding="utf-8") as fh:
                previous = json.load(fh)
            if content_signature(previous.get("jobs") or []) == content_signature(jobs):
                log("")
                log("数据无变化，跳过写入（避免空提交）")
                return 0
        except (json.JSONDecodeError, OSError) as exc:
            log("读取旧数据失败，将覆盖: {}".format(exc))

    with OUT_PATH.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    size_kb = OUT_PATH.stat().st_size / 1024
    log("")
    log("已写入 {} ({:.1f} KB)".format(OUT_PATH, size_kb))
    return 0


if __name__ == "__main__":
    sys.exit(main())
