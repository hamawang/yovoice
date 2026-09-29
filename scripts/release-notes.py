#!/usr/bin/env python3
"""从变更日志提取指定版本的发布说明。"""

import argparse
from pathlib import Path
import re
import sys


def extract_notes(changelog: str, tag: str) -> str:
    """只提取精确匹配的版本，缺失或空说明时阻止发布。"""
    if not re.fullmatch(r"v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", tag):
        raise ValueError(f"无效的版本标签：{tag}")
    version = tag.removeprefix("v")
    sections = re.split(r"(?m)^## ", changelog)
    matches = [section for section in sections[1:]
               if section.splitlines()[0].startswith(f"[{version}] - ")]
    if len(matches) != 1:
        raise ValueError(f"CHANGELOG.md 必须有且仅有一个 [{version}] 版本段落")
    section = matches[0]
    body = section.partition("\n")[2]
    if not any(line.strip() and not line.lstrip().startswith(("#", "<!--"))
               for line in body.splitlines()):
        raise ValueError(f"[{version}] 的发布说明为空")
    return "## " + section.strip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", help="版本标签，例如 v0.1.4")
    args = parser.parse_args()
    try:
        changelog = (Path(__file__).resolve().parent.parent / "CHANGELOG.md").read_text(encoding="utf-8")
        print(extract_notes(changelog, args.tag), end="")
    except (ValueError, OSError) as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
