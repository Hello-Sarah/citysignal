#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Events 数据校验器

用法:
    python3 tests/validate_data.py data/sample_events.tsv
    python3 tests/validate_data.py path/to/export.tsv --strict

输入是从 Google Sheet 的 Events 标签页导出的 TSV（含表头）。
分区（Zone）按城市查表校验，见 CITY_ZONES——必须和 Code.gs 的 CONFIG.CITIES 一致。
校验规则见 data/schema.md。

退出码:
    0  全部通过（或只有 WARN 且未加 --strict）
    1  有 ERROR，或加了 --strict 且有 WARN
    2  文件读不到 / 格式完全不可解析
"""

import argparse
import csv
import datetime
import io
import re
import sys
import urllib.parse
from collections import Counter

HEADER = [
    "City", "WeekId", "Zone", "SubGroup", "Category", "Title", "DateInfo",
    "Location", "Status", "PriceInfo", "MapLink", "Note", "Pick",
]
# 加入日历用的两列，选填，接在 Pick 后面。填了才出日历按钮。
TIME_COLS = ["StartAt", "EndAt"]
# 活动配图，选填：官方分享图 https 链接 + 图片来源网域
IMAGE_COLS = ["Image", "ImageCredit"]
HEADER_FULL = HEADER + TIME_COLS
HEADER_IMG = HEADER_FULL + IMAGE_COLS
# 报名/购票/官网链接，选填：官方链接 + 按钮类型
LINK_COLS = ["Link", "LinkType"]
HEADER_LINK = HEADER_IMG + LINK_COLS
LINK_TYPES = {"购票", "报名", "预约", "订位", "官网"}
WALLTIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?$")

# 分区是按城市定的：每个城市有自己的一套 Zone。
# 这张表必须和 Code.gs 里 CONFIG.CITIES 的 zones 保持一致——
# 城市耦合的字段只能靠查表校验，没法用一个全局枚举兜住。
CITY_ZONES = {
    "三藩市湾区": {"三藩市市内", "湾区市外", "华人社群活动", "演唱会与展览"},
    "香港": {"港岛", "九龙", "新界", "演唱会与展览"},
}
CITIES = set(CITY_ZONES)

STATUSES = {"已核实", "场地已核实", "未核实"}
COMMUNITY_SUBGROUPS = {"三藩市", "半岛", "南湾", "东湾", "北湾", "其他"}

REQUIRED = ["City", "WeekId", "Zone", "Category", "Title", "Location", "Status"]

MAPLINK_RE = re.compile(r"^https://www\.google\.com/maps/search/\?api=1&query=.+$")
WEEKID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Excel/Sheets 公式注入前缀
FORMULA_PREFIXES = ("=", "+", "@")


class Report:
    def __init__(self):
        self.errors = []
        self.warns = []

    def error(self, row, col, msg):
        self.errors.append((row, col, msg))

    def warn(self, row, col, msg):
        self.warns.append((row, col, msg))

    @property
    def ok(self):
        return not self.errors


def load(path):
    with io.open(path, encoding="utf-8", newline="") as f:
        return [r for r in csv.reader(f, delimiter="\t")]


def check_header(rows, rep):
    if not rows:
        rep.error(0, "-", "文件为空")
        return False
    head = [c.strip() for c in rows[0]]
    if head in (HEADER, HEADER_FULL, HEADER_IMG, HEADER_LINK):
        return True
    # 允许缺少末尾的 Pick 列（旧版数据）
    if head == HEADER[:-1]:
        rep.warn(1, "Pick", "缺少 Pick 列（旧版数据，精选功能不可用）")
        return True
    # 允许缺少首列 City（多城市之前的单城市数据）
    if head == HEADER[1:]:
        rep.warn(1, "City", "缺少 City 列（多城市之前的旧数据，无法按城市校验分区）")
        return True
    rep.error(1, "-", f"表头不匹配。\n  期望: {HEADER}\n  实际: {head}")
    return False


def check_rows(rows, rep):
    ncol = len(HEADER)
    weekids = set()
    head = [c.strip() for c in rows[0]]
    has_time = head in (HEADER_FULL, HEADER_IMG, HEADER_LINK)
    has_img = head in (HEADER_IMG, HEADER_LINK)
    has_link = head == HEADER_LINK
    seen_titles = {}

    for i, raw in enumerate(rows[1:], start=2):
        if not any(c.strip() for c in raw):
            continue  # 跳过纯空行

        cols = HEADER_LINK if has_link else HEADER_IMG if has_img else HEADER_FULL if has_time else HEADER
        if not (ncol - 1 <= len(raw) <= len(cols)):
            rep.error(i, "-", f"列数为 {len(raw)}，期望 {ncol}–{len(cols)}")
            continue
        r = dict(zip(cols, list(raw) + [""] * (len(cols) - len(raw))))

        # 0b) 报名/购票链接：只收 https；类型必须在枚举里
        if has_link:
            ln, lt = r["Link"].strip(), r["LinkType"].strip()
            if ln and not ln.lower().startswith("https://"):
                rep.error(i, "Link", f"只接受 https 链接，实际 {ln[:40]!r}")
            if lt and lt not in LINK_TYPES:
                rep.error(i, "LinkType", f"只能是 {sorted(LINK_TYPES)}，实际 {lt!r}")
            if lt and not ln:
                rep.error(i, "Link", "写了 LinkType 却没有 Link")
            if not ln:
                rep.warn(i, "Link", "没有报名/购票/官网链接")

        # 0a) 配图：只收 https；有图必须写来源
        if has_img:
            im, cr = r["Image"].strip(), r["ImageCredit"].strip()
            if im and not im.lower().startswith("https://"):
                rep.error(i, "Image", f"只接受 https 链接，实际 {im[:40]!r}")
            if im and not cr:
                rep.error(i, "ImageCredit", "有图片就必须写图片来源网域")

        # 0) StartAt / EndAt：格式、先后
        if has_time:
            s, e = r["StartAt"].strip(), r["EndAt"].strip()
            for col, v in (("StartAt", s), ("EndAt", e)):
                if v and not WALLTIME_RE.match(v):
                    rep.error(i, col, f"格式应为 2026-10-02 或 2026-10-02 13:00，实际 {v!r}")
            if e and not s:
                rep.error(i, "EndAt", "填了 EndAt 却没填 StartAt")
            if s and e and WALLTIME_RE.match(s) and WALLTIME_RE.match(e) and e.replace("T", " ") < s.replace("T", " "):
                rep.error(i, "EndAt", f"结束 {e} 早于开始 {s}")

        # 1) 必填
        for col in REQUIRED:
            if not r[col].strip():
                rep.error(i, col, "必填字段为空")

        # 2) 公式注入
        for col in HEADER:
            v = r[col]
            if v[:1] in FORMULA_PREFIXES:
                rep.error(i, col, f"以 {v[:1]!r} 开头，会被 Sheets 当公式解析")

        # 3) WeekId：格式 + 必须是周三
        wid = r["WeekId"].strip()
        if wid:
            if not WEEKID_RE.match(wid):
                rep.error(i, "WeekId", f"格式应为 YYYY-MM-DD，实际 {wid!r}")
            else:
                try:
                    d = datetime.date.fromisoformat(wid)
                    if d.weekday() != 2:  # 0=Mon, 2=Wed
                        rep.warn(i, "WeekId", f"{wid} 不是周三（WeekId 约定用该期周三）")
                    weekids.add(wid)
                except ValueError:
                    rep.error(i, "WeekId", f"不是合法日期: {wid!r}")

        # 4) 枚举
        city = r["City"].strip()
        if city and city not in CITIES:
            rep.error(i, "City", f"非法取值 {city!r}，应为 {sorted(CITIES)}")
        zone = r["Zone"].strip()
        if zone:
            if city in CITY_ZONES:
                if zone not in CITY_ZONES[city]:
                    rep.error(i, "Zone",
                              f"{city} 没有 {zone!r} 这个分区，应为 {sorted(CITY_ZONES[city])}")
            else:
                # City 非法或缺失时退回全局并集，至少能抓出完全瞎写的 Zone
                allz = set().union(*CITY_ZONES.values())
                if zone not in allz:
                    rep.error(i, "Zone", f"非法取值 {zone!r}，应为 {sorted(allz)}")
        if r["Status"].strip() and r["Status"].strip() not in STATUSES:
            rep.error(i, "Status", f"非法取值 {r['Status']!r}，应为 {sorted(STATUSES)}")

        # 5) SubGroup 规则
        sub, title = r["SubGroup"].strip(), r["Title"].strip()
        if sub and title and sub == title:
            rep.error(i, "SubGroup", "SubGroup 等于 Title —— 页面会把标题印两遍")
        if zone == "华人社群活动" and sub and sub not in COMMUNITY_SUBGROUPS:
            rep.error(i, "SubGroup", f"华人社群活动的 SubGroup 应为地区，实际 {sub!r}")
        if zone == "湾区市外" and sub and "·" not in sub:
            rep.warn(i, "SubGroup", f"湾区市外建议用 `玩·地名` 格式，实际 {sub!r}")

        # 6) MapLink
        ml = r["MapLink"].strip()
        if ml:
            if not ml.startswith("http"):
                rep.error(i, "MapLink", f"不是链接: {ml!r} —— 联系方式请放 Note 列")
            elif not MAPLINK_RE.match(ml):
                rep.warn(i, "MapLink", "不是标准 Google Maps search 链接格式")
        else:
            rep.warn(i, "MapLink", "缺少地图链接")

        # 7) Pick
        pk = r["Pick"].strip()
        if pk and len(pk) > 4:
            rep.warn(i, "Pick", f"Pick 建议用单个标记（如 ★），实际 {pk!r}")

        # 8) 同一城市同一期内重复标题
        key = (city, wid, title)
        if title:
            if key in seen_titles:
                rep.warn(i, "Title", f"与第 {seen_titles[key]} 行在同城市同一期内标题重复")
            else:
                seen_titles[key] = i

    return weekids


def summarize(rows):
    """输出核实率等评估指标"""
    if len(rows) < 2:
        return
    body = [r for r in rows[1:] if any(c.strip() for c in r)]
    idx = {c: n for n, c in enumerate(HEADER)}

    def get(r, col):
        n = idx[col]
        return r[n].strip() if n < len(r) else ""

    by_key = {}
    for r in body:
        by_key.setdefault((get(r, "City"), get(r, "WeekId")), []).append(r)

    cities = sorted({k[0] for k in by_key})
    print("\n=== 数据概况 ===")
    print(f"总条目: {len(body)}    城市: {len(cities)}    期数: {len(by_key)}")
    for key in sorted(by_key):
        city, wid = key
        g = by_key[key]
        st = Counter(get(r, "Status") for r in g)
        zn = Counter(get(r, "Zone") for r in g)
        picks = sum(1 for r in g if get(r, "Pick"))
        verified = st.get("已核实", 0)
        rate = verified / len(g) * 100 if g else 0
        head = f"{city} · {wid}" if city else wid
        print(f"\n  {head}  共 {len(g)} 条")
        print(f"    核实率(已核实/总数): {verified}/{len(g)} = {rate:.0f}%")
        print(f"    核实分布: " + "  ".join(f"{k} {v}" for k, v in st.most_common()))
        print(f"    分区分布: " + "  ".join(f"{k} {v}" for k, v in zn.most_common()))
        print(f"    精选(Pick): {picks} 条")


def main():
    ap = argparse.ArgumentParser(description="校验 Events 数据")
    ap.add_argument("path", help="TSV 文件路径（含表头）")
    ap.add_argument("--strict", action="store_true", help="把 WARN 也当作失败")
    args = ap.parse_args()

    try:
        rows = load(args.path)
    except OSError as e:
        print(f"读不到文件: {e}", file=sys.stderr)
        return 2

    rep = Report()
    if not check_header(rows, rep):
        for r, c, m in rep.errors:
            print(f"ERROR  第{r}行 [{c}] {m}")
        return 2

    check_rows(rows, rep)

    for r, c, m in rep.errors:
        print(f"ERROR  第{r}行 [{c}] {m}")
    for r, c, m in rep.warns:
        print(f"WARN   第{r}行 [{c}] {m}")

    summarize(rows)

    print(f"\n=== 校验结果 ===")
    print(f"ERROR {len(rep.errors)}    WARN {len(rep.warns)}")

    if rep.errors:
        print("❌ 校验未通过")
        return 1
    if args.strict and rep.warns:
        print("❌ --strict 下 WARN 视为失败")
        return 1
    print("✅ 校验通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
