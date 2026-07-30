#!/usr/bin/env python3
"""
sync_build_registry.py — Sync the Notion Build Registry table into the
fluxcc_sites table in opendia.db.

The Notion table (BUILD_REGISTRY_TABLE_ID in intake_pipeline.py) is the
authoritative client → site mapping for FluxCC static sites. This script
pulls every row and upserts it into fluxcc_sites so the inbox pipeline can
resolve a classified client_hint to a repo/CF project deterministically.

repo_path is derived from the local checkout layout (~/FluxCC/clients/<slug>
for client sites, ~/FluxCC/<slug> for flagship/template repos) and left NULL
with a warning when no local checkout exists.

Usage:
  python3 sync_build_registry.py          # sync
  python3 sync_build_registry.py --dry    # print what would change, no writes

Cron: daily is plenty — rows change only when a site is scaffolded/launched
(intake_pipeline.py also writes fluxcc_sites directly at scaffold time).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from intake_pipeline import _notion_req, BUILD_REGISTRY_TABLE_ID  # noqa: E402
from inbox_db import upsert_fluxcc_site  # noqa: E402

FLUXCC_ROOT = Path.home() / "FluxCC"

HEADER = ["client", "slug", "cf_project", "preview_url",
          "custom_domain", "gitlab_repo", "status", "launched"]


def _plain(cell) -> str:
    text = "".join(t.get("plain_text", "") for t in cell).strip()
    return "" if text in ("—", "-") else text


def fetch_registry_rows():
    """Yield dicts keyed by HEADER for every data row of the Notion table."""
    cursor = None
    first = True
    while True:
        path = f"blocks/{BUILD_REGISTRY_TABLE_ID}/children?page_size=100"
        if cursor:
            path += f"&start_cursor={cursor}"
        res = _notion_req("GET", path)
        for block in res.get("results", []):
            cells = block.get("table_row", {}).get("cells", [])
            vals = [_plain(c) for c in cells]
            if first:
                first = False
                continue  # header row
            if not any(vals):
                continue
            row = dict(zip(HEADER, vals + [""] * (len(HEADER) - len(vals))))
            yield row
        if not res.get("has_more"):
            break
        cursor = res.get("next_cursor")


def derive_repo_path(slug: str):
    for rel in (f"clients/{slug}", f"templates/{slug}", slug):
        if (FLUXCC_ROOT / rel).is_dir():
            return rel
    return None


def main():
    dry = "--dry" in sys.argv
    synced, missing_local = 0, []
    for row in fetch_registry_rows():
        slug = row["slug"]
        if not slug:
            continue
        repo_path = derive_repo_path(slug)
        if repo_path is None:
            missing_local.append(slug)
        fields = dict(
            display_name=row["client"],
            slug=slug,
            repo_path=repo_path,
            cf_project=row["cf_project"] or slug,
            gitlab_repo=row["gitlab_repo"],
            preview_url=row["preview_url"],
            custom_domain=row["custom_domain"],
            status=row["status"],
        )
        if dry:
            print(f"would upsert {slug}: {fields}")
        else:
            upsert_fluxcc_site(slug, **fields)
            synced += 1
    if not dry:
        print(f"Synced {synced} sites into fluxcc_sites.")
    if missing_local:
        print(f"[warn] no local checkout under ~/FluxCC for: {', '.join(missing_local)}",
              file=sys.stderr)


if __name__ == "__main__":
    main()
