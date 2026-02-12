import os
import re
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent.parent / "kitchenos.db"
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
USING_POSTGRES = DATABASE_URL.startswith("postgres://") or DATABASE_URL.startswith("postgresql://")

if USING_POSTGRES:
    import psycopg
    from psycopg.rows import dict_row


SQLITE_SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY(role_id) REFERENCES roles(id)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  yield_amount REAL NOT NULL,
  yield_unit TEXT NOT NULL,
  portion_size TEXT,
  instructions TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL,
  inventory_item_id INTEGER NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  prep_note TEXT,
  FOREIGN KEY(recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
  FOREIGN KEY(inventory_item_id) REFERENCES inventory_items(id)
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  base_unit TEXT NOT NULL,
  current_quantity REAL NOT NULL DEFAULT 0,
  par_level REAL NOT NULL DEFAULT 0,
  reorder_threshold REAL NOT NULL DEFAULT 0,
  cost_per_unit REAL NOT NULL DEFAULT 0,
  supplier TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_item_id INTEGER NOT NULL,
  user_id INTEGER,
  change_quantity REAL NOT NULL,
  previous_quantity REAL NOT NULL,
  new_quantity REAL NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(inventory_item_id) REFERENCES inventory_items(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS production_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_date TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS production_plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  production_plan_id INTEGER NOT NULL,
  recipe_id INTEGER NOT NULL,
  target_yield_amount REAL NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(production_plan_id) REFERENCES production_plans(id) ON DELETE CASCADE,
  FOREIGN KEY(recipe_id) REFERENCES recipes(id)
);

CREATE TABLE IF NOT EXISTS grocery_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  list_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS grocery_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grocery_list_id INTEGER NOT NULL,
  inventory_item_id INTEGER,
  name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  vendor TEXT,
  status TEXT NOT NULL DEFAULT 'needed',
  from_shortage INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(grocery_list_id) REFERENCES grocery_lists(id) ON DELETE CASCADE,
  FOREIGN KEY(inventory_item_id) REFERENCES inventory_items(id)
);

CREATE TABLE IF NOT EXISTS prep_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_date TEXT NOT NULL,
  list_type TEXT NOT NULL,
  title TEXT NOT NULL,
  recipe_id INTEGER,
  priority TEXT NOT NULL DEFAULT 'med',
  due_time TEXT,
  assigned_to INTEGER,
  status TEXT NOT NULL DEFAULT 'todo',
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(recipe_id) REFERENCES recipes(id),
  FOREIGN KEY(assigned_to) REFERENCES users(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS chef_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  shift_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  station TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);
"""

POSTGRES_SCHEMA_SQL = (
    SQLITE_SCHEMA_SQL.replace("PRAGMA foreign_keys = ON;", "")
    .replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
    .replace("REAL", "DOUBLE PRECISION")
)


def now_iso() -> str:
    return datetime.utcnow().isoformat()


def _adapt_query(query: str) -> str:
    if USING_POSTGRES:
        return query.replace("?", "%s")
    return query


def _extract_insert_table(query: str) -> str | None:
    m = re.match(r"\s*INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)", query, flags=re.IGNORECASE)
    return m.group(1) if m else None


def get_conn() -> Any:
    if USING_POSTGRES:
        return psycopg.connect(DATABASE_URL, row_factory=dict_row)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_conn()
    try:
        if USING_POSTGRES:
            statements = [s.strip() for s in POSTGRES_SCHEMA_SQL.split(";") if s.strip()]
            pending = statements[:]

            # Postgres validates FK dependencies at CREATE TABLE time.
            # Execute in multiple passes to tolerate declaration order.
            while pending:
                next_pending: list[str] = []
                progressed = False
                first_error: Exception | None = None
                for stmt in pending:
                    try:
                        with conn.cursor() as cur:
                            cur.execute(stmt)
                        conn.commit()
                        progressed = True
                    except Exception as ex:
                        conn.rollback()
                        next_pending.append(stmt)
                        if first_error is None:
                            first_error = ex
                if not progressed:
                    raise first_error if first_error else RuntimeError("Failed to initialize Postgres schema")
                pending = next_pending
        else:
            conn.executescript(SQLITE_SCHEMA_SQL)
            conn.commit()
    finally:
        conn.close()


def execute(query: str, params: tuple = ()) -> int:
    conn = get_conn()
    try:
        sql = _adapt_query(query)
        cur = conn.execute(sql, params)
        conn.commit()

        if USING_POSTGRES:
            table = _extract_insert_table(query)
            if table:
                try:
                    seq_row = conn.execute("SELECT currval(pg_get_serial_sequence(%s, 'id')) AS id", (table,)).fetchone()
                    return int(seq_row["id"])
                except Exception:
                    return 0
            return 0
        return int(cur.lastrowid)
    finally:
        conn.close()


def execute_many(query: str, rows: list[tuple]) -> None:
    conn = get_conn()
    try:
        sql = _adapt_query(query)
        if USING_POSTGRES:
            with conn.cursor() as cur:
                cur.executemany(sql, rows)
        else:
            conn.executemany(sql, rows)
        conn.commit()
    finally:
        conn.close()


def query_all(query: str, params: tuple = ()) -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(_adapt_query(query), params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def query_one(query: str, params: tuple = ()) -> dict | None:
    conn = get_conn()
    try:
        row = conn.execute(_adapt_query(query), params).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def seed_data(password_hash: str) -> None:
    role_count = query_one("SELECT COUNT(*) AS c FROM roles")
    if role_count and role_count["c"] > 0:
        return

    now = now_iso()
    roles = [("admin",), ("manager",), ("prep",)]
    execute_many("INSERT INTO roles(name) VALUES (?)", roles)

    admin_role = query_one("SELECT id FROM roles WHERE name='admin'")["id"]
    manager_role = query_one("SELECT id FROM roles WHERE name='manager'")["id"]
    prep_role = query_one("SELECT id FROM roles WHERE name='prep'")["id"]

    users = [
        ("admin", "Kitchen Admin", password_hash, admin_role, 1, now),
        ("chef1", "Chef Maria", password_hash, manager_role, 1, now),
        ("prep1", "Prep Alex", password_hash, prep_role, 1, now),
    ]
    execute_many(
        """
        INSERT INTO users(username, full_name, password_hash, role_id, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        users,
    )

    inventory = [
        ("Tomato", "Produce", "kg", 12, 10, 6, 3.2, "Local Farm", now, now),
        ("Olive Oil", "Dry Goods", "L", 5, 4, 2, 8.5, "Mediterranean Supply", now, now),
        ("Chicken Breast", "Protein", "kg", 9, 8, 5, 7.3, "Metro Meats", now, now),
        ("Garlic", "Produce", "kg", 2, 2, 1, 4.0, "Local Farm", now, now),
        ("Basil", "Produce", "kg", 1, 1.2, 0.6, 12.0, "Green Herbs", now, now),
        ("Heavy Cream", "Dairy", "L", 1.5, 3, 2, 4.5, "Dairy Hub", now, now),
    ]
    execute_many(
        """
        INSERT INTO inventory_items(
          name, category, base_unit, current_quantity, par_level,
          reorder_threshold, cost_per_unit, supplier, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        inventory,
    )

    admin_id = query_one("SELECT id FROM users WHERE username='admin'")["id"]
    tomato_id = query_one("SELECT id FROM inventory_items WHERE name='Tomato'")["id"]
    oil_id = query_one("SELECT id FROM inventory_items WHERE name='Olive Oil'")["id"]
    garlic_id = query_one("SELECT id FROM inventory_items WHERE name='Garlic'")["id"]
    basil_id = query_one("SELECT id FROM inventory_items WHERE name='Basil'")["id"]
    chicken_id = query_one("SELECT id FROM inventory_items WHERE name='Chicken Breast'")["id"]
    cream_id = query_one("SELECT id FROM inventory_items WHERE name='Heavy Cream'")["id"]

    recipes = [
        ("Tomato Basil Sauce", "Sauce", 4, "L", "250 ml", "1) Roast tomatoes.\n2) Blend with garlic and oil.\n3) Finish with basil.", admin_id, now, now),
        ("Poached Chicken", "Protein", 20, "portion", "1 portion", "1) Season chicken.\n2) Poach gently.\n3) Chill and portion.", admin_id, now, now),
        ("Cream Base", "Prep", 3, "L", "100 ml", "1) Heat cream slowly.\n2) Reduce to nappe consistency.", admin_id, now, now),
    ]
    execute_many(
        """
        INSERT INTO recipes(name, category, yield_amount, yield_unit, portion_size, instructions, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        recipes,
    )

    sauce_id = query_one("SELECT id FROM recipes WHERE name='Tomato Basil Sauce'")["id"]
    chicken_recipe_id = query_one("SELECT id FROM recipes WHERE name='Poached Chicken'")["id"]
    cream_recipe_id = query_one("SELECT id FROM recipes WHERE name='Cream Base'")["id"]

    recipe_ings = [
        (sauce_id, tomato_id, 6, "kg", "rough chop"),
        (sauce_id, oil_id, 0.8, "L", "for roasting"),
        (sauce_id, garlic_id, 0.2, "kg", "minced"),
        (sauce_id, basil_id, 0.15, "kg", "add at finish"),
        (chicken_recipe_id, chicken_id, 7, "kg", "trimmed"),
        (cream_recipe_id, cream_id, 2.5, "L", "reduce slowly"),
    ]
    execute_many(
        """
        INSERT INTO recipe_ingredients(recipe_id, inventory_item_id, quantity, unit, prep_note)
        VALUES (?, ?, ?, ?, ?)
        """,
        recipe_ings,
    )

    today = datetime.utcnow().date().isoformat()
    tomorrow = (datetime.utcnow().date() + timedelta(days=1)).isoformat()

    prep_tasks = [
        (today, "daily", "Prep tomato sauce batch", sauce_id, "high", "09:30", None, "todo", "For lunch service", admin_id, now, now),
        (today, "additional", "Trim chicken portions", chicken_recipe_id, "med", "11:00", None, "in_progress", "Need 40 portions", admin_id, now, now),
    ]
    execute_many(
        """
        INSERT INTO prep_tasks(task_date, list_type, title, recipe_id, priority, due_time, assigned_to, status, notes, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        prep_tasks,
    )

    schedules = [
        (2, today, "08:00", "16:00", "Hot Line", "Lead prep and pass", "scheduled", admin_id, now, now),
        (3, today, "09:00", "17:00", "Cold Prep", "Salads + sauce support", "scheduled", admin_id, now, now),
        (2, tomorrow, "10:00", "18:00", "Grill", "Dinner shift", "scheduled", admin_id, now, now),
    ]
    execute_many(
        """
        INSERT INTO chef_schedules(user_id, shift_date, start_time, end_time, station, notes, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        schedules,
    )
