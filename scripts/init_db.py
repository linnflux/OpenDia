#!/usr/bin/env python3
"""Initialize the OpenDia SQLite database with schema and seed data."""

import sqlite3
import os

DB_PATH = os.path.expanduser("~/OpenDia/opendia.db")


def init_db():
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
            updated_at TEXT DEFAULT (datetime('now'))
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
    ]
    for name, desc in divisions:
        cur.execute(
            "INSERT OR IGNORE INTO divisions (name, description) VALUES (?, ?)",
            (name, desc),
        )

    conn.commit()
    conn.close()
    print(f"Database initialized at {DB_PATH}")
    print(f"Tables: divisions, companies, people, projects, tasks")


if __name__ == "__main__":
    init_db()
