#!/usr/bin/env python3
import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.auth import hash_password
from app.db import execute, init_db, query_one


def main() -> None:
    parser = argparse.ArgumentParser(description="Create or update admin user")
    parser.add_argument("--username", required=True)
    parser.add_argument("--full-name", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()

    init_db()
    role = query_one("SELECT id FROM roles WHERE name='admin'")
    if not role:
        raise RuntimeError("Roles not initialized. Start app once before running this script.")

    existing = query_one("SELECT id FROM users WHERE username=?", (args.username,))
    if existing:
        execute(
            "UPDATE users SET full_name=?, password_hash=?, role_id=?, active=1 WHERE id=?",
            (args.full_name, hash_password(args.password), role["id"], existing["id"]),
        )
        print(f"Updated admin user: {args.username}")
    else:
        execute(
            "INSERT INTO users(username, full_name, password_hash, role_id, active, created_at) VALUES (?, ?, ?, ?, 1, datetime('now'))",
            (args.username, args.full_name, hash_password(args.password), role["id"]),
        )
        print(f"Created admin user: {args.username}")


if __name__ == "__main__":
    main()
