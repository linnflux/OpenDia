#!/usr/bin/env python3
"""CLI helper for OpenDia SQLite database CRUD operations."""

import sqlite3
import sys
import os
from datetime import datetime

DB_PATH = os.path.expanduser("~/OpenDia/opendia.db")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn


def now():
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


# --- Division helpers ---

def get_division_id(conn, name):
    """Resolve a division name (case-insensitive) to its ID."""
    row = conn.execute(
        "SELECT id FROM divisions WHERE LOWER(name) = LOWER(?)", (name,)
    ).fetchone()
    return row["id"] if row else None


def list_divisions():
    conn = get_conn()
    rows = conn.execute("SELECT id, name, description FROM divisions ORDER BY id").fetchall()
    conn.close()
    for r in rows:
        print(f"  {r['id']}: {r['name']} - {r['description']}")


# --- Company CRUD ---

def add_company(name, short_name=None, website=None, notes=None):
    conn = get_conn()
    conn.execute(
        "INSERT INTO companies (name, short_name, website, notes) VALUES (?, ?, ?, ?)",
        (name, short_name, website, notes),
    )
    conn.commit()
    cid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    print(f"Added company '{name}' (id={cid})")
    return cid


def list_companies():
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, short_name, website FROM companies ORDER BY name"
    ).fetchall()
    conn.close()
    if not rows:
        print("  No companies found.")
        return
    for r in rows:
        short = f" ({r['short_name']})" if r["short_name"] else ""
        web = f" - {r['website']}" if r["website"] else ""
        print(f"  {r['id']}: {r['name']}{short}{web}")


def get_company(company_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM companies WHERE id = ?", (company_id,)).fetchone()
    conn.close()
    if row:
        for key in row.keys():
            print(f"  {key}: {row[key]}")
    else:
        print(f"  Company {company_id} not found.")


def update_company(company_id, **kwargs):
    conn = get_conn()
    kwargs["updated_at"] = now()
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values()) + [company_id]
    conn.execute(f"UPDATE companies SET {sets} WHERE id = ?", vals)
    conn.commit()
    conn.close()
    print(f"Updated company {company_id}")


# --- People CRUD ---

def add_person(name, company_id=None, email=None, phone=None, role=None, notes=None):
    conn = get_conn()
    conn.execute(
        "INSERT INTO people (name, company_id, email, phone, role, notes) VALUES (?, ?, ?, ?, ?, ?)",
        (name, company_id, email, phone, role, notes),
    )
    conn.commit()
    pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    print(f"Added person '{name}' (id={pid})")
    return pid


def list_people(company_id=None):
    conn = get_conn()
    if company_id:
        rows = conn.execute(
            "SELECT p.id, p.name, p.email, p.role, c.name as company "
            "FROM people p LEFT JOIN companies c ON p.company_id = c.id "
            "WHERE p.company_id = ? ORDER BY p.name",
            (company_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT p.id, p.name, p.email, p.role, c.name as company "
            "FROM people p LEFT JOIN companies c ON p.company_id = c.id "
            "ORDER BY p.name"
        ).fetchall()
    conn.close()
    if not rows:
        print("  No people found.")
        return
    for r in rows:
        company = f" @ {r['company']}" if r["company"] else ""
        role = f" ({r['role']})" if r["role"] else ""
        email = f" <{r['email']}>" if r["email"] else ""
        print(f"  {r['id']}: {r['name']}{role}{company}{email}")


# --- Project CRUD ---

def add_project(name, company_id=None, division=None, status="active", notes=None):
    conn = get_conn()
    division_id = get_division_id(conn, division) if division else None
    conn.execute(
        "INSERT INTO projects (name, company_id, division_id, status, notes) VALUES (?, ?, ?, ?, ?)",
        (name, company_id, division_id, status, notes),
    )
    conn.commit()
    pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    print(f"Added project '{name}' (id={pid})")
    return pid


def list_projects(company_id=None, status=None):
    conn = get_conn()
    query = (
        "SELECT p.id, p.name, p.status, c.name as company, d.name as division "
        "FROM projects p "
        "LEFT JOIN companies c ON p.company_id = c.id "
        "LEFT JOIN divisions d ON p.division_id = d.id "
    )
    conditions, params = [], []
    if company_id:
        conditions.append("p.company_id = ?")
        params.append(company_id)
    if status:
        conditions.append("p.status = ?")
        params.append(status)
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY p.name"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    if not rows:
        print("  No projects found.")
        return
    for r in rows:
        company = f" ({r['company']})" if r["company"] else ""
        div = f" [{r['division']}]" if r["division"] else ""
        print(f"  {r['id']}: {r['name']}{company}{div} - {r['status']}")


# --- Task CRUD ---

def add_task(title, project_id=None, company_id=None, division=None, status="open", notion_id=None, notion_url=None, notes=None):
    conn = get_conn()
    division_id = get_division_id(conn, division) if division else None
    conn.execute(
        "INSERT INTO tasks (title, project_id, company_id, division_id, status, notion_id, notion_url, notes) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (title, project_id, company_id, division_id, status, notion_id, notion_url, notes),
    )
    conn.commit()
    tid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    print(f"Added task '{title}' (id={tid})")
    return tid


def list_tasks(company_id=None, status=None):
    conn = get_conn()
    query = (
        "SELECT t.id, t.title, t.status, c.name as company, d.name as division "
        "FROM tasks t "
        "LEFT JOIN companies c ON t.company_id = c.id "
        "LEFT JOIN divisions d ON t.division_id = d.id "
    )
    conditions, params = [], []
    if company_id:
        conditions.append("t.company_id = ?")
        params.append(company_id)
    if status:
        conditions.append("t.status = ?")
        params.append(status)
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY t.created_at DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    if not rows:
        print("  No tasks found.")
        return
    for r in rows:
        company = f" ({r['company']})" if r["company"] else ""
        div = f" [{r['division']}]" if r["division"] else ""
        print(f"  {r['id']}: {r['title']}{company}{div} - {r['status']}")


# --- Lookup (search across tables) ---

def lookup(term):
    conn = get_conn()
    pattern = f"%{term}%"
    print(f"Searching for '{term}'...\n")

    companies = conn.execute(
        "SELECT id, name, short_name FROM companies WHERE name LIKE ? OR short_name LIKE ?",
        (pattern, pattern),
    ).fetchall()
    if companies:
        print("Companies:")
        for r in companies:
            short = f" ({r['short_name']})" if r["short_name"] else ""
            print(f"  {r['id']}: {r['name']}{short}")

    people = conn.execute(
        "SELECT p.id, p.name, p.role, c.name as company FROM people p "
        "LEFT JOIN companies c ON p.company_id = c.id "
        "WHERE p.name LIKE ? OR p.email LIKE ?",
        (pattern, pattern),
    ).fetchall()
    if people:
        print("People:")
        for r in people:
            company = f" @ {r['company']}" if r["company"] else ""
            print(f"  {r['id']}: {r['name']}{company}")

    projects = conn.execute(
        "SELECT p.id, p.name, p.status, c.name as company FROM projects p "
        "LEFT JOIN companies c ON p.company_id = c.id "
        "WHERE p.name LIKE ?",
        (pattern,),
    ).fetchall()
    if projects:
        print("Projects:")
        for r in projects:
            company = f" ({r['company']})" if r["company"] else ""
            print(f"  {r['id']}: {r['name']}{company} - {r['status']}")

    tasks = conn.execute(
        "SELECT t.id, t.title, t.status, c.name as company FROM tasks t "
        "LEFT JOIN companies c ON t.company_id = c.id "
        "WHERE t.title LIKE ?",
        (pattern,),
    ).fetchall()
    if tasks:
        print("Tasks:")
        for r in tasks:
            company = f" ({r['company']})" if r["company"] else ""
            print(f"  {r['id']}: {r['title']}{company} - {r['status']}")

    if not any([companies, people, projects, tasks]):
        print("  No results found.")

    conn.close()


# --- CLI ---

def print_usage():
    print("Usage: python3 db_helper.py <command> [args]")
    print()
    print("Commands:")
    print("  add-company <name> [short_name]     Add a company")
    print("  list-companies                       List all companies")
    print("  get-company <id>                     Show company details")
    print("  add-person <name> [company_id]       Add a person")
    print("  list-people [company_id]             List people")
    print("  add-project <name> [company_id] [division]  Add a project")
    print("  list-projects [status]               List projects")
    print("  add-task <title> [company_id] [division]    Add a task")
    print("  list-tasks [status]                  List tasks")
    print("  list-divisions                       List divisions")
    print("  lookup <term>                        Search across all tables")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print_usage()
        sys.exit(1)

    cmd = sys.argv[1]
    args = sys.argv[2:]

    if cmd == "add-company":
        if not args:
            print("Error: company name required")
            sys.exit(1)
        add_company(args[0], short_name=args[1] if len(args) > 1 else None)

    elif cmd == "list-companies":
        list_companies()

    elif cmd == "get-company":
        if not args:
            print("Error: company id required")
            sys.exit(1)
        get_company(int(args[0]))

    elif cmd == "add-person":
        if not args:
            print("Error: person name required")
            sys.exit(1)
        add_person(args[0], company_id=int(args[1]) if len(args) > 1 else None)

    elif cmd == "list-people":
        list_people(company_id=int(args[0]) if args else None)

    elif cmd == "add-project":
        if not args:
            print("Error: project name required")
            sys.exit(1)
        add_project(
            args[0],
            company_id=int(args[1]) if len(args) > 1 else None,
            division=args[2] if len(args) > 2 else None,
        )

    elif cmd == "list-projects":
        list_projects(status=args[0] if args else None)

    elif cmd == "add-task":
        if not args:
            print("Error: task title required")
            sys.exit(1)
        add_task(
            args[0],
            company_id=int(args[1]) if len(args) > 1 else None,
            division=args[2] if len(args) > 2 else None,
        )

    elif cmd == "list-tasks":
        list_tasks(status=args[0] if args else None)

    elif cmd == "list-divisions":
        list_divisions()

    elif cmd == "lookup":
        if not args:
            print("Error: search term required")
            sys.exit(1)
        lookup(args[0])

    else:
        print(f"Unknown command: {cmd}")
        print_usage()
        sys.exit(1)
