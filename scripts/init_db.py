#!/usr/bin/env python3
"""Initialize the OpenDia SQLite database with schema and seed data."""

import sqlite3
import os

DB_PATH = os.path.expanduser("~/OpenDia/opendia.db")


def ensure_companies_columns(conn):
    """Add billing-flag columns to an existing companies table.

    Both flags reached the live database through ad-hoc ALTER TABLE and were
    never in the schema, so a fresh clone came up without them: set-nonprofit
    failed with "no such column" and every billing run silently mis-billed.

    Idempotent — safe on every run, no-ops once applied. Returns the list of
    changes made, so callers can report honestly instead of always claiming
    success.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(companies)")}
    done = []
    if "nonprofit" not in cols:
        conn.execute(
            "ALTER TABLE companies ADD COLUMN nonprofit INTEGER NOT NULL DEFAULT 0"
        )
        done.append("added companies.nonprofit")
    if "full_rate" not in cols:
        conn.execute(
            "ALTER TABLE companies ADD COLUMN full_rate INTEGER NOT NULL DEFAULT 0"
        )
        done.append("added companies.full_rate")

    # The live full_rate column was added without NOT NULL, so it can hold
    # NULLs that `WHERE full_rate = 1` skips silently. Normalising them makes
    # the nullable column behave exactly like the NOT NULL one the schema now
    # declares, which is cheaper than rebuilding the table. Same shape as the
    # sort_order NULL fix in dashboard/server/db.js.
    n = conn.execute(
        "UPDATE companies SET full_rate = 0 WHERE full_rate IS NULL"
    ).rowcount
    if n:
        done.append(f"normalised {n} NULL full_rate value(s) to 0")
    return done


def migrate(db_path=DB_PATH):
    """Run column migrations against an existing database.

    Separate from init_db() on purpose: init_db() refuses to touch a populated
    database without --force, and --force re-initialises everything. The live
    database is exactly the case that needs migrating, so it needs a door that
    is not also a demolition permit.
    """
    if not os.path.exists(db_path):
        print(f"No database at {db_path} — nothing to migrate.")
        return
    conn = sqlite3.connect(db_path)
    try:
        done = ensure_companies_columns(conn)
        conn.commit()
    finally:
        conn.close()
    if done:
        for line in done:
            print(f"  {line}")
        print(f"Migrated {db_path}")
    else:
        print(f"{db_path} is already up to date.")


def init_db(force=False):
    if not force and os.path.exists(DB_PATH) and os.path.getsize(DB_PATH) > 10000:
        print(f"WARNING: {DB_PATH} already exists ({os.path.getsize(DB_PATH):,} bytes).")
        print("Database appears populated. Run with --force to re-initialize.")
        return
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    cur = conn.cursor()

    cur.executescript("""
        CREATE TABLE IF NOT EXISTS divisions (
            id INTEGER PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            description TEXT
        );

        CREATE TABLE IF NOT EXISTS companies (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            short_name TEXT,
            website TEXT,
            notion_id TEXT,
            toggl_client_id TEXT,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            -- Billing flags, mutually exclusive. Both drive real money in
            -- billing_month.py, so they belong in the schema rather than in
            -- whatever ALTER TABLE someone once ran by hand.
            --   nonprofit: OpenDia platform hours are not billed at all.
            --   full_rate: Toggl AND OpenDia hours bill in full, with no
            --              overlap deduction. Funds the nonprofit subsidy.
            nonprofit INTEGER NOT NULL DEFAULT 0,
            full_rate INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS people (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT,
            phone TEXT,
            role TEXT,
            company_id INTEGER REFERENCES companies(id),
            notion_id TEXT,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            company_id INTEGER REFERENCES companies(id),
            division_id INTEGER REFERENCES divisions(id),
            status TEXT DEFAULT 'active',
            notion_id TEXT,
            toggl_project_id TEXT,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            project_id INTEGER REFERENCES projects(id),
            company_id INTEGER REFERENCES companies(id),
            division_id INTEGER REFERENCES divisions(id),
            status TEXT DEFAULT 'open',
            notion_id TEXT,
            notion_url TEXT,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_companies_short_name ON companies(short_name);
        CREATE INDEX IF NOT EXISTS idx_companies_notion_id ON companies(notion_id);
        CREATE INDEX IF NOT EXISTS idx_people_company_id ON people(company_id);
        CREATE INDEX IF NOT EXISTS idx_projects_company_id ON projects(company_id);
        CREATE INDEX IF NOT EXISTS idx_projects_division_id ON projects(division_id);
        CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_company_id ON tasks(company_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_notion_id ON tasks(notion_id);
    """)

    # Seed divisions (upsert)
    divisions = [
        ("WordFlux", "WordPress Design/Dev/Hosting"),
        ("WatchThreat", "Security, Backups, Hardware"),
        ("AmPen", "Penetration Testing"),
        ("Bedford AI", "AI & Automation"),
        ("ADA Web Work", "Compliance"),
        ("FluxCC", "Astro static site templates & client website builds"),
    ]
    for name, desc in divisions:
        cur.execute(
            "INSERT OR IGNORE INTO divisions (name, description) VALUES (?, ?)",
            (name, desc),
        )

    # Covers the --force path over a pre-existing database, whose companies
    # table CREATE TABLE IF NOT EXISTS leaves untouched.
    ensure_companies_columns(conn)

    conn.commit()
    conn.close()
    print(f"Database initialized at {DB_PATH}")
    print(f"Tables: divisions, companies, people, projects, tasks")


if __name__ == "__main__":
    import sys
    if "--migrate" in sys.argv:
        migrate()
    else:
        init_db(force="--force" in sys.argv)
