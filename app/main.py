import csv
import io
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request

from .auth import create_token, get_current_user, hash_password, require_roles, verify_password
from .db import execute, execute_many, init_db, now_iso, query_all, query_one, seed_data

app = FastAPI(title="Kitchen OS", version="1.0.0")
BASE_DIR = Path(__file__).resolve().parent

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


@app.on_event("startup")
def startup() -> None:
    init_db()
    seed_data(hash_password("admin123"))


def role_id_by_name(role: str) -> int:
    row = query_one("SELECT id FROM roles WHERE name=?", (role,))
    if not row:
        raise HTTPException(status_code=400, detail=f"Unknown role: {role}")
    return int(row["id"])


def normalize_role_input(role: str) -> str:
    value = (role or "").strip().lower().replace("-", " ").replace("_", " ")
    mapping = {
        "admin": "admin",
        "owner": "admin",
        "chef": "manager",
        "manager": "manager",
        "chef manager": "manager",
        "prep": "prep",
        "prep chef": "prep",
    }
    return mapping.get(value, value)


def parse_float(value: Any, field_name: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field_name} must be a valid number")


def get_recipe_ingredients(recipe_id: int) -> list[dict[str, Any]]:
    return query_all(
        """
        SELECT ri.id, ri.recipe_id, ri.inventory_item_id, ri.quantity, ri.unit, ri.prep_note,
               i.name AS ingredient_name, i.cost_per_unit
        FROM recipe_ingredients ri
        JOIN inventory_items i ON i.id = ri.inventory_item_id
        WHERE ri.recipe_id = ?
        ORDER BY ri.id
        """,
        (recipe_id,),
    )


def recipe_cost(recipe_id: int) -> float:
    total = 0.0
    for i in get_recipe_ingredients(recipe_id):
        total += float(i["quantity"]) * float(i["cost_per_unit"])
    return round(total, 2)


def calc_plan_requirements(plan_id: int) -> list[dict[str, Any]]:
    items = query_all(
        """
        SELECT ppi.id, ppi.recipe_id, ppi.target_yield_amount,
               r.name AS recipe_name, r.yield_amount
        FROM production_plan_items ppi
        JOIN recipes r ON r.id = ppi.recipe_id
        WHERE ppi.production_plan_id = ?
        """,
        (plan_id,),
    )

    agg: dict[int, dict[str, Any]] = {}
    for p in items:
        ratio = float(p["target_yield_amount"]) / float(p["yield_amount"])
        for ing in get_recipe_ingredients(int(p["recipe_id"])):
            item_id = int(ing["inventory_item_id"])
            required = float(ing["quantity"]) * ratio
            if item_id not in agg:
                inv = query_one(
                    "SELECT id, name, base_unit, current_quantity, supplier FROM inventory_items WHERE id=?",
                    (item_id,),
                )
                agg[item_id] = {
                    "inventory_item_id": item_id,
                    "name": inv["name"],
                    "unit": inv["base_unit"],
                    "supplier": inv.get("supplier"),
                    "required_quantity": 0.0,
                    "available_quantity": float(inv["current_quantity"]),
                }
            agg[item_id]["required_quantity"] += required

    output = []
    for _, r in agg.items():
        required = round(r["required_quantity"], 3)
        shortage = max(required - float(r["available_quantity"]), 0.0)
        output.append(
            {
                **r,
                "required_quantity": required,
                "shortage_quantity": round(shortage, 3),
            }
        )
    output.sort(key=lambda x: x["name"])
    return output


@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/api/auth/login")
def login(payload: dict):
    username = payload.get("username", "").strip()
    password = payload.get("password", "")
    row = query_one(
        """
        SELECT u.id, u.password_hash, u.active, u.full_name, r.name AS role
        FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE u.username = ?
        """,
        (username,),
    )
    if not row or not verify_password(password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if int(row["active"]) != 1:
        raise HTTPException(status_code=403, detail="User inactive")

    token = create_token(int(row["id"]))
    return {
        "token": token,
        "user": {"id": row["id"], "username": username, "full_name": row["full_name"], "role": row["role"]},
    }


@app.get("/api/auth/me")
def me(user=Depends(get_current_user)):
    return user


@app.get("/api/dashboard")
def dashboard(user=Depends(get_current_user)):
    today = datetime.utcnow().date().isoformat()
    daily = query_all("SELECT * FROM prep_tasks WHERE task_date=? AND list_type='daily' ORDER BY priority DESC, due_time", (today,))
    additional = query_all(
        "SELECT * FROM prep_tasks WHERE task_date=? AND list_type='additional' ORDER BY priority DESC, due_time", (today,)
    )
    latest_plan = query_one("SELECT id FROM production_plans WHERE plan_date=? ORDER BY id DESC LIMIT 1", (today,))
    production = []
    shortages = []
    if latest_plan:
        production = query_all(
            """
            SELECT ppi.id, r.name AS recipe_name, ppi.target_yield_amount, r.yield_unit
            FROM production_plan_items ppi
            JOIN recipes r ON r.id = ppi.recipe_id
            WHERE ppi.production_plan_id = ?
            """,
            (latest_plan["id"],),
        )
        shortages = [i for i in calc_plan_requirements(int(latest_plan["id"])) if i["shortage_quantity"] > 0]

    low_items = query_all(
        """
        SELECT * FROM inventory_items
        WHERE current_quantity <= reorder_threshold OR current_quantity <= par_level
        ORDER BY current_quantity ASC
        """
    )
    return {
        "today": today,
        "prep_daily": daily,
        "prep_additional": additional,
        "production_list": production,
        "low_items": low_items,
        "shortages": shortages,
    }


@app.get("/api/users")
def list_users(user=Depends(require_roles("admin"))):
    return query_all(
        """
        SELECT u.id, u.username, u.full_name, u.active, r.name AS role, u.created_at
        FROM users u
        JOIN roles r ON r.id = u.role_id
        ORDER BY u.id
        """
    )


@app.get("/api/staff")
def list_staff(user=Depends(get_current_user)):
    return query_all(
        """
        SELECT u.id, u.username, u.full_name, u.active, r.name AS role
        FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE u.active = 1
        ORDER BY u.full_name
        """
    )


@app.post("/api/users")
def create_user(payload: dict, user=Depends(require_roles("admin"))):
    username = payload["username"].strip()
    full_name = payload["full_name"].strip()
    password = payload["password"]
    role = normalize_role_input(payload["role"])
    rid = role_id_by_name(role)

    existing = query_one("SELECT id FROM users WHERE username=?", (username,))
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")

    uid = execute(
        """
        INSERT INTO users(username, full_name, password_hash, role_id, active, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
        """,
        (username, full_name, hash_password(password), rid, now_iso()),
    )
    return {"id": uid}


@app.put("/api/users/{user_id}")
def update_user(user_id: int, payload: dict, user=Depends(require_roles("admin"))):
    current = query_one("SELECT id FROM users WHERE id=?", (user_id,))
    if not current:
        raise HTTPException(status_code=404, detail="User not found")

    full_name = payload.get("full_name")
    active = payload.get("active")
    role = normalize_role_input(payload.get("role")) if payload.get("role") else None
    password = payload.get("password")

    if role:
        execute("UPDATE users SET role_id=? WHERE id=?", (role_id_by_name(role), user_id))
    if full_name is not None:
        execute("UPDATE users SET full_name=? WHERE id=?", (full_name, user_id))
    if active is not None:
        execute("UPDATE users SET active=? WHERE id=?", (1 if active else 0, user_id))
    if password:
        execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(password), user_id))
    return {"ok": True}


@app.get("/api/recipes")
def list_recipes(q: str | None = None, category: str | None = None, user=Depends(get_current_user)):
    sql = "SELECT * FROM recipes WHERE 1=1"
    params: list[Any] = []
    if q:
        sql += " AND name LIKE ?"
        params.append(f"%{q}%")
    if category:
        sql += " AND category = ?"
        params.append(category)
    sql += " ORDER BY name"
    recipes = query_all(sql, tuple(params))
    for r in recipes:
        r["cost_total"] = recipe_cost(int(r["id"]))
    return recipes


@app.get("/api/recipes/export-csv")
def export_recipes_csv(user=Depends(get_current_user)):
    rows = query_all(
        """
        SELECT r.id, r.name, r.category, r.yield_amount, r.yield_unit, r.portion_size, r.instructions,
               i.name AS ingredient_name, ri.quantity, ri.unit, ri.prep_note
        FROM recipes r
        LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
        LEFT JOIN inventory_items i ON i.id = ri.inventory_item_id
        ORDER BY r.name, ri.id
        """
    )
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "recipe_name",
            "category",
            "yield_amount",
            "yield_unit",
            "portion_size",
            "instructions",
            "ingredient_name",
            "ingredient_quantity",
            "ingredient_unit",
            "ingredient_prep_note",
        ]
    )
    for r in rows:
        writer.writerow(
            [
                r["name"],
                r["category"],
                r["yield_amount"],
                r["yield_unit"],
                r["portion_size"] or "",
                r["instructions"] or "",
                r.get("ingredient_name") or "",
                r.get("quantity") or "",
                r.get("unit") or "",
                r.get("prep_note") or "",
            ]
        )
    csv_text = output.getvalue()
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="recipes_export.csv"'},
    )


@app.post("/api/recipes/import-csv")
def import_recipes_csv(payload: dict, user=Depends(require_roles("admin", "manager"))):
    csv_text = payload.get("csv", "").strip()
    if not csv_text:
        raise HTTPException(status_code=400, detail="Missing CSV content")

    reader = csv.DictReader(io.StringIO(csv_text))
    required = {
        "recipe_name",
        "category",
        "yield_amount",
        "yield_unit",
        "portion_size",
        "instructions",
        "ingredient_name",
        "ingredient_quantity",
        "ingredient_unit",
        "ingredient_prep_note",
    }
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        raise HTTPException(status_code=400, detail="Invalid recipe CSV headers")

    grouped: dict[str, dict[str, Any]] = {}
    for row in reader:
        name = (row.get("recipe_name") or "").strip()
        if not name:
            continue
        if name not in grouped:
            grouped[name] = {
                "category": (row.get("category") or "prep").strip() or "prep",
                "yield_amount": float(row.get("yield_amount") or 1),
                "yield_unit": (row.get("yield_unit") or "unit").strip() or "unit",
                "portion_size": (row.get("portion_size") or "").strip() or None,
                "instructions": (row.get("instructions") or "").strip(),
                "ingredients": [],
            }

        ing_name = (row.get("ingredient_name") or "").strip()
        if ing_name:
            inv = query_one("SELECT id, base_unit FROM inventory_items WHERE name=?", (ing_name,))
            if not inv:
                raise HTTPException(status_code=400, detail=f"Unknown inventory item in CSV: {ing_name}")
            qty = float(row.get("ingredient_quantity") or 0)
            grouped[name]["ingredients"].append(
                {
                    "inventory_item_id": inv["id"],
                    "quantity": qty,
                    "unit": (row.get("ingredient_unit") or inv["base_unit"] or "").strip(),
                    "prep_note": (row.get("ingredient_prep_note") or "").strip() or None,
                }
            )

    imported = 0
    for name, data in grouped.items():
        existing = query_one("SELECT id FROM recipes WHERE name=?", (name,))
        if existing:
            recipe_id = existing["id"]
            execute(
                """
                UPDATE recipes
                SET category=?, yield_amount=?, yield_unit=?, portion_size=?, instructions=?, updated_at=?
                WHERE id=?
                """,
                (
                    data["category"],
                    data["yield_amount"],
                    data["yield_unit"],
                    data["portion_size"],
                    data["instructions"],
                    now_iso(),
                    recipe_id,
                ),
            )
            execute("DELETE FROM recipe_ingredients WHERE recipe_id=?", (recipe_id,))
        else:
            recipe_id = execute(
                """
                INSERT INTO recipes(name, category, yield_amount, yield_unit, portion_size, instructions, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    name,
                    data["category"],
                    data["yield_amount"],
                    data["yield_unit"],
                    data["portion_size"],
                    data["instructions"],
                    user["id"],
                    now_iso(),
                    now_iso(),
                ),
            )
        for ing in data["ingredients"]:
            execute(
                """
                INSERT INTO recipe_ingredients(recipe_id, inventory_item_id, quantity, unit, prep_note)
                VALUES (?, ?, ?, ?, ?)
                """,
                (recipe_id, ing["inventory_item_id"], ing["quantity"], ing["unit"], ing["prep_note"]),
            )
        imported += 1
    return {"ok": True, "imported_recipes": imported}


@app.get("/api/recipes/{recipe_id}")
def get_recipe(recipe_id: int, user=Depends(get_current_user)):
    recipe = query_one("SELECT * FROM recipes WHERE id=?", (recipe_id,))
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    ingredients = get_recipe_ingredients(recipe_id)
    return {**recipe, "ingredients": ingredients, "cost_total": recipe_cost(recipe_id)}


@app.post("/api/recipes")
def create_recipe(payload: dict, user=Depends(require_roles("admin", "manager"))):
    if not payload.get("name", "").strip():
        raise HTTPException(status_code=400, detail="Recipe name is required")
    yield_amount = parse_float(payload.get("yield_amount", 0), "yield_amount")
    if yield_amount <= 0:
        raise HTTPException(status_code=400, detail="Yield amount must be greater than 0")

    now = now_iso()
    rid = execute(
        """
        INSERT INTO recipes(name, category, yield_amount, yield_unit, portion_size, instructions, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload["name"],
            payload["category"],
            yield_amount,
            payload["yield_unit"],
            payload.get("portion_size"),
            payload.get("instructions", ""),
            user["id"],
            now,
            now,
        ),
    )
    ingredients = payload.get("ingredients", [])
    for i in ingredients:
        if not query_one("SELECT id FROM inventory_items WHERE id=?", (i["inventory_item_id"],)):
            raise HTTPException(status_code=400, detail=f"Invalid inventory item: {i['inventory_item_id']}")
        execute(
            """
            INSERT INTO recipe_ingredients(recipe_id, inventory_item_id, quantity, unit, prep_note)
            VALUES (?, ?, ?, ?, ?)
            """,
            (rid, i["inventory_item_id"], i["quantity"], i.get("unit", ""), i.get("prep_note")),
        )
    return {"id": rid}


@app.put("/api/recipes/{recipe_id}")
def update_recipe(recipe_id: int, payload: dict, user=Depends(require_roles("admin", "manager"))):
    old = query_one("SELECT id FROM recipes WHERE id=?", (recipe_id,))
    if not old:
        raise HTTPException(status_code=404, detail="Recipe not found")
    if not payload.get("name", "").strip():
        raise HTTPException(status_code=400, detail="Recipe name is required")
    yield_amount = parse_float(payload.get("yield_amount", 0), "yield_amount")
    if yield_amount <= 0:
        raise HTTPException(status_code=400, detail="Yield amount must be greater than 0")

    execute(
        """
        UPDATE recipes
        SET name=?, category=?, yield_amount=?, yield_unit=?, portion_size=?, instructions=?, updated_at=?
        WHERE id=?
        """,
        (
            payload["name"],
            payload["category"],
            yield_amount,
            payload["yield_unit"],
            payload.get("portion_size"),
            payload.get("instructions", ""),
            now_iso(),
            recipe_id,
        ),
    )
    execute("DELETE FROM recipe_ingredients WHERE recipe_id=?", (recipe_id,))
    for i in payload.get("ingredients", []):
        if not query_one("SELECT id FROM inventory_items WHERE id=?", (i["inventory_item_id"],)):
            raise HTTPException(status_code=400, detail=f"Invalid inventory item: {i['inventory_item_id']}")
        execute(
            "INSERT INTO recipe_ingredients(recipe_id, inventory_item_id, quantity, unit, prep_note) VALUES (?, ?, ?, ?, ?)",
            (recipe_id, i["inventory_item_id"], i["quantity"], i.get("unit", ""), i.get("prep_note")),
        )
    return {"ok": True}


@app.delete("/api/recipes/{recipe_id}")
def delete_recipe(recipe_id: int, user=Depends(require_roles("admin", "manager"))):
    row = query_one("SELECT id FROM recipes WHERE id=?", (recipe_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Recipe not found")
    execute("DELETE FROM recipes WHERE id=?", (recipe_id,))
    return {"ok": True}


@app.post("/api/recipes/{recipe_id}/duplicate")
def duplicate_recipe(recipe_id: int, user=Depends(require_roles("admin", "manager"))):
    recipe = query_one("SELECT * FROM recipes WHERE id=?", (recipe_id,))
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    ingredients = get_recipe_ingredients(recipe_id)
    new_id = execute(
        """
        INSERT INTO recipes(name, category, yield_amount, yield_unit, portion_size, instructions, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            f"{recipe['name']} (Copy)",
            recipe["category"],
            recipe["yield_amount"],
            recipe["yield_unit"],
            recipe.get("portion_size"),
            recipe["instructions"],
            user["id"],
            now_iso(),
            now_iso(),
        ),
    )
    for i in ingredients:
        execute(
            "INSERT INTO recipe_ingredients(recipe_id, inventory_item_id, quantity, unit, prep_note) VALUES (?, ?, ?, ?, ?)",
            (new_id, i["inventory_item_id"], i["quantity"], i["unit"], i.get("prep_note")),
        )
    return {"id": new_id}


@app.get("/api/recipes/{recipe_id}/scale")
def scale_recipe(recipe_id: int, target_yield: float, user=Depends(get_current_user)):
    recipe = query_one("SELECT id, name, yield_amount, yield_unit FROM recipes WHERE id=?", (recipe_id,))
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")

    ratio = target_yield / float(recipe["yield_amount"])
    scaled = []
    for i in get_recipe_ingredients(recipe_id):
        scaled.append(
            {
                "ingredient": i["ingredient_name"],
                "quantity": round(float(i["quantity"]) * ratio, 3),
                "unit": i["unit"],
                "prep_note": i["prep_note"],
            }
        )
    return {
        "recipe_id": recipe_id,
        "recipe_name": recipe["name"],
        "target_yield": target_yield,
        "yield_unit": recipe["yield_unit"],
        "scaled_ingredients": scaled,
    }


@app.get("/api/recipes/{recipe_id}/export", response_class=PlainTextResponse)
def export_recipe(recipe_id: int, user=Depends(get_current_user)):
    r = get_recipe(recipe_id, user)
    lines = [
        f"Recipe: {r['name']}",
        f"Category: {r['category']}",
        f"Yield: {r['yield_amount']} {r['yield_unit']}",
        f"Portion: {r.get('portion_size') or '-'}",
        f"Cost: ${r['cost_total']}",
        "",
        "Ingredients:",
    ]
    for i in r["ingredients"]:
        lines.append(f"- {i['ingredient_name']}: {i['quantity']} {i['unit']} ({i.get('prep_note') or '-'})")
    lines.append("")
    lines.append("Instructions:")
    lines.append(r["instructions"])
    return "\n".join(lines)


@app.get("/api/inventory")
def list_inventory(q: str | None = None, user=Depends(get_current_user)):
    sql = "SELECT * FROM inventory_items WHERE 1=1"
    params: list[Any] = []
    if q:
        sql += " AND name LIKE ?"
        params.append(f"%{q}%")
    sql += " ORDER BY name"
    return query_all(sql, tuple(params))


@app.get("/api/inventory/export-csv")
def export_inventory_csv(user=Depends(get_current_user)):
    rows = query_all(
        """
        SELECT name, category, base_unit, current_quantity, par_level, reorder_threshold, cost_per_unit, supplier
        FROM inventory_items
        ORDER BY name
        """
    )
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "name",
            "category",
            "base_unit",
            "current_quantity",
            "par_level",
            "reorder_threshold",
            "cost_per_unit",
            "supplier",
        ]
    )
    for r in rows:
        writer.writerow(
            [
                r["name"],
                r["category"],
                r["base_unit"],
                r["current_quantity"],
                r["par_level"],
                r["reorder_threshold"],
                r["cost_per_unit"],
                r["supplier"] or "",
            ]
        )
    csv_text = output.getvalue()
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="inventory_export.csv"'},
    )


@app.post("/api/inventory/import-csv")
def import_inventory_csv(payload: dict, user=Depends(require_roles("admin", "manager"))):
    csv_text = payload.get("csv", "").strip()
    if not csv_text:
        raise HTTPException(status_code=400, detail="Missing CSV content")

    reader = csv.DictReader(io.StringIO(csv_text))
    required = {
        "name",
        "category",
        "base_unit",
        "current_quantity",
        "par_level",
        "reorder_threshold",
        "cost_per_unit",
        "supplier",
    }
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        raise HTTPException(status_code=400, detail="Invalid inventory CSV headers")

    imported = 0
    for row in reader:
        name = (row.get("name") or "").strip()
        if not name:
            continue
        category = (row.get("category") or "Uncategorized").strip() or "Uncategorized"
        base_unit = (row.get("base_unit") or "unit").strip() or "unit"
        current_quantity = float(row.get("current_quantity") or 0)
        par_level = float(row.get("par_level") or 0)
        reorder_threshold = float(row.get("reorder_threshold") or 0)
        cost_per_unit = float(row.get("cost_per_unit") or 0)
        supplier = (row.get("supplier") or "").strip() or None

        existing = query_one("SELECT id, current_quantity FROM inventory_items WHERE name=?", (name,))
        if existing:
            execute(
                """
                UPDATE inventory_items
                SET category=?, base_unit=?, current_quantity=?, par_level=?, reorder_threshold=?, cost_per_unit=?, supplier=?, updated_at=?
                WHERE id=?
                """,
                (
                    category,
                    base_unit,
                    current_quantity,
                    par_level,
                    reorder_threshold,
                    cost_per_unit,
                    supplier,
                    now_iso(),
                    existing["id"],
                ),
            )
            prev_q = float(existing["current_quantity"])
            change = round(current_quantity - prev_q, 3)
            execute(
                """
                INSERT INTO inventory_transactions(inventory_item_id, user_id, change_quantity, previous_quantity, new_quantity, reason, source, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    existing["id"],
                    user["id"],
                    change,
                    prev_q,
                    current_quantity,
                    "import_csv",
                    "inventory_import",
                    "CSV inventory import",
                    now_iso(),
                ),
            )
        else:
            item_id = execute(
                """
                INSERT INTO inventory_items(name, category, base_unit, current_quantity, par_level, reorder_threshold, cost_per_unit, supplier, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    name,
                    category,
                    base_unit,
                    current_quantity,
                    par_level,
                    reorder_threshold,
                    cost_per_unit,
                    supplier,
                    now_iso(),
                    now_iso(),
                ),
            )
            execute(
                """
                INSERT INTO inventory_transactions(inventory_item_id, user_id, change_quantity, previous_quantity, new_quantity, reason, source, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item_id,
                    user["id"],
                    current_quantity,
                    0,
                    current_quantity,
                    "import_csv",
                    "inventory_import",
                    "CSV inventory import (new item)",
                    now_iso(),
                ),
            )
        imported += 1
    return {"ok": True, "imported_items": imported}


@app.post("/api/inventory")
def create_inventory(payload: dict, user=Depends(require_roles("admin", "manager"))):
    now = now_iso()
    iid = execute(
        """
        INSERT INTO inventory_items(name, category, base_unit, current_quantity, par_level, reorder_threshold, cost_per_unit, supplier, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload["name"],
            payload["category"],
            payload["base_unit"],
            payload.get("current_quantity", 0),
            payload.get("par_level", 0),
            payload.get("reorder_threshold", 0),
            payload.get("cost_per_unit", 0),
            payload.get("supplier"),
            now,
            now,
        ),
    )
    return {"id": iid}


@app.put("/api/inventory/{item_id}")
def update_inventory(item_id: int, payload: dict, user=Depends(require_roles("admin", "manager"))):
    existing = query_one("SELECT id FROM inventory_items WHERE id=?", (item_id,))
    if not existing:
        raise HTTPException(status_code=404, detail="Item not found")

    execute(
        """
        UPDATE inventory_items
        SET name=?, category=?, base_unit=?, par_level=?, reorder_threshold=?, cost_per_unit=?, supplier=?, updated_at=?
        WHERE id=?
        """,
        (
            payload["name"],
            payload["category"],
            payload["base_unit"],
            payload.get("par_level", 0),
            payload.get("reorder_threshold", 0),
            payload.get("cost_per_unit", 0),
            payload.get("supplier"),
            now_iso(),
            item_id,
        ),
    )
    return {"ok": True}


@app.get("/api/inventory/low-items")
def low_items(user=Depends(get_current_user)):
    return query_all(
        """
        SELECT * FROM inventory_items
        WHERE current_quantity <= reorder_threshold OR current_quantity <= par_level
        ORDER BY current_quantity ASC
        """
    )


@app.post("/api/inventory/{item_id}/adjust")
def adjust_inventory(item_id: int, payload: dict, user=Depends(require_roles("admin", "manager", "prep"))):
    item = query_one("SELECT * FROM inventory_items WHERE id=?", (item_id,))
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    change = float(payload["change_quantity"])
    prev_q = float(item["current_quantity"])
    new_q = round(prev_q + change, 3)
    if new_q < 0:
        raise HTTPException(status_code=400, detail="Resulting quantity cannot be negative")

    execute("UPDATE inventory_items SET current_quantity=?, updated_at=? WHERE id=?", (new_q, now_iso(), item_id))
    execute(
        """
        INSERT INTO inventory_transactions(
          inventory_item_id, user_id, change_quantity, previous_quantity,
          new_quantity, reason, source, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            item_id,
            user["id"],
            change,
            prev_q,
            new_q,
            payload.get("reason", "adjustment"),
            payload.get("source", "manual"),
            payload.get("notes"),
            now_iso(),
        ),
    )
    return {"ok": True, "new_quantity": new_q}


@app.post("/api/inventory/count")
def inventory_count(payload: dict, user=Depends(require_roles("admin", "manager"))):
    rows = payload.get("items", [])
    for row in rows:
        item = query_one("SELECT current_quantity FROM inventory_items WHERE id=?", (row["id"],))
        if not item:
            continue
        prev_q = float(item["current_quantity"])
        counted_q = float(row["current_quantity"])
        change = round(counted_q - prev_q, 3)
        execute("UPDATE inventory_items SET current_quantity=?, updated_at=? WHERE id=?", (counted_q, now_iso(), row["id"]))
        execute(
            """
            INSERT INTO inventory_transactions(inventory_item_id, user_id, change_quantity, previous_quantity, new_quantity, reason, source, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (row["id"], user["id"], change, prev_q, counted_q, "counted", "count_page", row.get("notes"), now_iso()),
        )
    return {"ok": True, "updated": len(rows)}


@app.get("/api/inventory/transactions")
def inventory_transactions(limit: int = 200, user=Depends(get_current_user)):
    return query_all(
        """
        SELECT t.*, i.name AS item_name, u.full_name AS user_name
        FROM inventory_transactions t
        JOIN inventory_items i ON i.id = t.inventory_item_id
        LEFT JOIN users u ON u.id = t.user_id
        ORDER BY t.id DESC
        LIMIT ?
        """,
        (limit,),
    )


@app.get("/api/production-plans")
def list_production_plans(plan_date: str | None = None, user=Depends(get_current_user)):
    if plan_date:
        return query_all("SELECT * FROM production_plans WHERE plan_date=? ORDER BY id DESC", (plan_date,))
    return query_all("SELECT * FROM production_plans ORDER BY plan_date DESC, id DESC")


@app.post("/api/production-plans")
def create_production_plan(payload: dict, user=Depends(require_roles("admin", "manager"))):
    now = now_iso()
    pid = execute(
        """
        INSERT INTO production_plans(plan_date, name, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (payload.get("plan_date") or datetime.utcnow().date().isoformat(), payload.get("name", "Daily Production"), "draft", user["id"], now, now),
    )
    return {"id": pid}


@app.get("/api/production-plans/{plan_id}")
def get_production_plan(plan_id: int, user=Depends(get_current_user)):
    plan = query_one("SELECT * FROM production_plans WHERE id=?", (plan_id,))
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    items = query_all(
        """
        SELECT ppi.*, r.name AS recipe_name, r.yield_unit
        FROM production_plan_items ppi
        JOIN recipes r ON r.id = ppi.recipe_id
        WHERE ppi.production_plan_id = ?
        """,
        (plan_id,),
    )
    requirements = calc_plan_requirements(plan_id)
    shortages = [r for r in requirements if r["shortage_quantity"] > 0]
    return {"plan": plan, "items": items, "requirements": requirements, "shortages": shortages}


@app.post("/api/production-plans/{plan_id}/items")
def add_production_item(plan_id: int, payload: dict, user=Depends(require_roles("admin", "manager"))):
    exists = query_one("SELECT id FROM production_plans WHERE id=?", (plan_id,))
    if not exists:
        raise HTTPException(status_code=404, detail="Plan not found")
    target_yield_amount = parse_float(payload.get("target_yield_amount", 0), "target_yield_amount")
    if target_yield_amount <= 0:
        raise HTTPException(status_code=400, detail="Target yield must be greater than 0")
    recipe = query_one("SELECT id FROM recipes WHERE id=?", (payload["recipe_id"],))
    if not recipe:
        raise HTTPException(status_code=400, detail="Invalid recipe_id")
    iid = execute(
        "INSERT INTO production_plan_items(production_plan_id, recipe_id, target_yield_amount, created_at) VALUES (?, ?, ?, ?)",
        (plan_id, payload["recipe_id"], target_yield_amount, now_iso()),
    )
    execute("UPDATE production_plans SET updated_at=? WHERE id=?", (now_iso(), plan_id))
    return {"id": iid}


@app.post("/api/production-plans/{plan_id}/send-shortages")
def send_shortages(plan_id: int, payload: dict | None = None, user=Depends(require_roles("admin", "manager"))):
    plan = query_one("SELECT * FROM production_plans WHERE id=?", (plan_id,))
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")

    shortages = [s for s in calc_plan_requirements(plan_id) if s["shortage_quantity"] > 0]
    if not shortages:
        return {"ok": True, "added": 0, "grocery_list_id": None}

    active_list = query_one("SELECT id FROM grocery_lists WHERE list_date=? AND status='open' ORDER BY id DESC LIMIT 1", (plan["plan_date"],))
    if active_list:
        gl_id = int(active_list["id"])
    else:
        gl_id = execute(
            "INSERT INTO grocery_lists(name, list_date, status, created_by, created_at, updated_at) VALUES (?, ?, 'open', ?, ?, ?)",
            (f"Purchasing {plan['plan_date']}", plan["plan_date"], user["id"], now_iso(), now_iso()),
        )

    rows = []
    for s in shortages:
        rows.append(
            (
                gl_id,
                s["inventory_item_id"],
                s["name"],
                s["shortage_quantity"],
                s["unit"],
                s.get("supplier"),
                "needed",
                1,
                now_iso(),
            )
        )
    execute_many(
        """
        INSERT INTO grocery_list_items(
          grocery_list_id, inventory_item_id, name, quantity, unit,
          vendor, status, from_shortage, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    return {"ok": True, "added": len(rows), "grocery_list_id": gl_id}


@app.get("/api/grocery-lists")
def list_grocery_lists(list_date: str | None = None, user=Depends(get_current_user)):
    if list_date:
        return query_all("SELECT * FROM grocery_lists WHERE list_date=? ORDER BY id DESC", (list_date,))
    return query_all("SELECT * FROM grocery_lists ORDER BY list_date DESC, id DESC")


@app.post("/api/grocery-lists")
def create_grocery_list(payload: dict, user=Depends(require_roles("admin", "manager"))):
    list_date = payload.get("list_date") or datetime.utcnow().date().isoformat()
    gid = execute(
        "INSERT INTO grocery_lists(name, list_date, status, created_by, created_at, updated_at) VALUES (?, ?, 'open', ?, ?, ?)",
        (payload.get("name", f"Purchasing {list_date}"), list_date, user["id"], now_iso(), now_iso()),
    )
    return {"id": gid}


@app.get("/api/grocery-lists/{list_id}")
def get_grocery_list(list_id: int, user=Depends(get_current_user)):
    gl = query_one("SELECT * FROM grocery_lists WHERE id=?", (list_id,))
    if not gl:
        raise HTTPException(status_code=404, detail="List not found")
    items = query_all("SELECT * FROM grocery_list_items WHERE grocery_list_id=? ORDER BY id", (list_id,))
    return {"list": gl, "items": items}


@app.post("/api/grocery-lists/{list_id}/items")
def add_grocery_item(list_id: int, payload: dict, user=Depends(require_roles("admin", "manager"))):
    gl = query_one("SELECT id FROM grocery_lists WHERE id=?", (list_id,))
    if not gl:
        raise HTTPException(status_code=404, detail="List not found")

    item_id = payload.get("inventory_item_id")
    name = payload.get("name")
    unit = payload.get("unit")
    vendor = payload.get("vendor")
    if item_id and (not name or not unit):
        inv = query_one("SELECT name, base_unit, supplier FROM inventory_items WHERE id=?", (item_id,))
        if inv:
            name = name or inv["name"]
            unit = unit or inv["base_unit"]
            vendor = vendor or inv["supplier"]

    gid = execute(
        """
        INSERT INTO grocery_list_items(grocery_list_id, inventory_item_id, name, quantity, unit, vendor, status, from_shortage, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'needed', 0, ?)
        """,
        (list_id, item_id, name, payload["quantity"], unit, vendor, now_iso()),
    )
    return {"id": gid}


@app.put("/api/grocery-items/{item_id}")
def update_grocery_item(item_id: int, payload: dict, user=Depends(require_roles("admin", "manager", "prep"))):
    item = query_one("SELECT * FROM grocery_list_items WHERE id=?", (item_id,))
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    new_status = payload.get("status", item["status"])
    execute("UPDATE grocery_list_items SET status=? WHERE id=?", (new_status, item_id))

    if new_status == "received":
        if not item.get("inventory_item_id"):
            raise HTTPException(status_code=400, detail="Cannot receive into inventory without linked item")
        inv = query_one("SELECT current_quantity FROM inventory_items WHERE id=?", (item["inventory_item_id"],))
        prev_q = float(inv["current_quantity"])
        new_q = round(prev_q + float(item["quantity"]), 3)
        execute("UPDATE inventory_items SET current_quantity=?, updated_at=? WHERE id=?", (new_q, now_iso(), item["inventory_item_id"]))
        execute(
            """
            INSERT INTO inventory_transactions(inventory_item_id, user_id, change_quantity, previous_quantity, new_quantity, reason, source, notes, created_at)
            VALUES (?, ?, ?, ?, ?, 'received', 'grocery', ?, ?)
            """,
            (item["inventory_item_id"], user["id"], item["quantity"], prev_q, new_q, f"Received via grocery item {item_id}", now_iso()),
        )

    return {"ok": True}


@app.get("/api/prep-tasks")
def list_prep_tasks(task_date: str | None = None, list_type: str | None = None, user=Depends(get_current_user)):
    task_date = task_date or datetime.utcnow().date().isoformat()
    sql = """
      SELECT t.*, u.full_name AS assigned_name, r.name AS recipe_name
      FROM prep_tasks t
      LEFT JOIN users u ON u.id = t.assigned_to
      LEFT JOIN recipes r ON r.id = t.recipe_id
      WHERE t.task_date=?
    """
    params: list[Any] = [task_date]
    if list_type:
        sql += " AND t.list_type = ?"
        params.append(list_type)
    sql += " ORDER BY CASE t.priority WHEN 'high' THEN 1 WHEN 'med' THEN 2 ELSE 3 END, t.due_time"
    return query_all(sql, tuple(params))


@app.post("/api/prep-tasks")
def create_prep_task(payload: dict, user=Depends(require_roles("admin", "manager"))):
    list_type = (payload.get("list_type", "daily") or "daily").strip().lower()
    if list_type not in ["daily", "additional"]:
        raise HTTPException(status_code=400, detail="list_type must be daily or additional")
    if not payload.get("title", "").strip():
        raise HTTPException(status_code=400, detail="Task title is required")

    now = now_iso()
    tid = execute(
        """
        INSERT INTO prep_tasks(task_date, list_type, title, recipe_id, priority, due_time, assigned_to, status, notes, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload.get("task_date") or datetime.utcnow().date().isoformat(),
            list_type,
            payload["title"],
            payload.get("recipe_id"),
            payload.get("priority", "med"),
            payload.get("due_time"),
            payload.get("assigned_to"),
            payload.get("status", "todo"),
            payload.get("notes"),
            user["id"],
            now,
            now,
        ),
    )
    return {"id": tid}


@app.put("/api/prep-tasks/{task_id}")
def update_prep_task(task_id: int, payload: dict, user=Depends(require_roles("admin", "manager", "prep"))):
    t = query_one("SELECT id FROM prep_tasks WHERE id=?", (task_id,))
    if not t:
        raise HTTPException(status_code=404, detail="Task not found")
    execute(
        """
        UPDATE prep_tasks
        SET title=?, recipe_id=?, priority=?, due_time=?, assigned_to=?, status=?, notes=?, list_type=?, task_date=?, updated_at=?
        WHERE id=?
        """,
        (
            payload["title"],
            payload.get("recipe_id"),
            payload.get("priority", "med"),
            payload.get("due_time"),
            payload.get("assigned_to"),
            payload.get("status", "todo"),
            payload.get("notes"),
            payload.get("list_type", "daily"),
            payload.get("task_date") or datetime.utcnow().date().isoformat(),
            now_iso(),
            task_id,
        ),
    )
    return {"ok": True}


@app.patch("/api/prep-tasks/{task_id}/status")
def patch_prep_status(task_id: int, payload: dict, user=Depends(require_roles("admin", "manager", "prep"))):
    status = payload.get("status")
    if status not in ["todo", "in_progress", "done"]:
        raise HTTPException(status_code=400, detail="Invalid status")
    execute("UPDATE prep_tasks SET status=?, updated_at=? WHERE id=?", (status, now_iso(), task_id))
    return {"ok": True}


@app.delete("/api/prep-tasks/{task_id}")
def delete_prep_task(task_id: int, user=Depends(require_roles("admin", "manager", "prep"))):
    row = query_one("SELECT id FROM prep_tasks WHERE id=?", (task_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    execute("DELETE FROM prep_tasks WHERE id=?", (task_id,))
    return {"ok": True}


@app.get("/api/schedules")
def list_schedules(shift_date: str | None = None, user=Depends(get_current_user)):
    sql = """
      SELECT s.*, u.full_name AS chef_name, c.full_name AS created_by_name
      FROM chef_schedules s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN users c ON c.id = s.created_by
      WHERE 1=1
    """
    params: list[Any] = []
    if shift_date:
        sql += " AND s.shift_date = ?"
        params.append(shift_date)
    sql += " ORDER BY s.shift_date, s.start_time"
    return query_all(sql, tuple(params))


@app.post("/api/schedules")
def create_schedule(payload: dict, user=Depends(require_roles("admin", "manager"))):
    sid = execute(
        """
        INSERT INTO chef_schedules(user_id, shift_date, start_time, end_time, station, notes, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload["user_id"],
            payload["shift_date"],
            payload["start_time"],
            payload["end_time"],
            payload.get("station"),
            payload.get("notes"),
            payload.get("status", "scheduled"),
            user["id"],
            now_iso(),
            now_iso(),
        ),
    )
    return {"id": sid}


@app.put("/api/schedules/{schedule_id}")
def update_schedule(schedule_id: int, payload: dict, user=Depends(require_roles("admin", "manager"))):
    row = query_one("SELECT id FROM chef_schedules WHERE id=?", (schedule_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Schedule not found")
    execute(
        """
        UPDATE chef_schedules
        SET user_id=?, shift_date=?, start_time=?, end_time=?, station=?, notes=?, status=?, updated_at=?
        WHERE id=?
        """,
        (
            payload["user_id"],
            payload["shift_date"],
            payload["start_time"],
            payload["end_time"],
            payload.get("station"),
            payload.get("notes"),
            payload.get("status", "scheduled"),
            now_iso(),
            schedule_id,
        ),
    )
    return {"ok": True}


@app.delete("/api/schedules/{schedule_id}")
def delete_schedule(schedule_id: int, user=Depends(require_roles("admin", "manager"))):
    execute("DELETE FROM chef_schedules WHERE id=?", (schedule_id,))
    return {"ok": True}


@app.get("/api/analytics")
def analytics(user=Depends(get_current_user)):
    waste = query_all(
        """
        SELECT i.name, ABS(SUM(t.change_quantity)) AS waste_qty
        FROM inventory_transactions t
        JOIN inventory_items i ON i.id = t.inventory_item_id
        WHERE t.reason='waste' AND t.change_quantity < 0
        GROUP BY i.name
        ORDER BY waste_qty DESC
        LIMIT 10
        """
    )
    low = query_all(
        """
        SELECT name, current_quantity, reorder_threshold
        FROM inventory_items
        ORDER BY (current_quantity - reorder_threshold) ASC
        LIMIT 10
        """
    )
    recipes = query_all("SELECT id, name, yield_amount, yield_unit FROM recipes ORDER BY name")
    costs = [{"recipe": r["name"], "cost": recipe_cost(r["id"]), "yield": f"{r['yield_amount']} {r['yield_unit']}"} for r in recipes]
    return {"waste_summary": waste, "top_low_items": low, "recipe_cost_breakdown": costs}
