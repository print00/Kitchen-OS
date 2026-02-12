# Kitchen OS (BOH Kitchen Management)

Local-first kitchen operations app for recipes, inventory, production planning, grocery purchasing, prep tasks, and chef scheduling.

## Architecture
- Backend: FastAPI (`/api/*`) + SQLite (`kitchenos.db`)
- Frontend: single-page HTML/CSS/JS served by FastAPI
- Auth: local username/password + bearer token table
- Role-based permissions: `admin`, `manager`, `prep`

## Core Modules Included
- Dashboard (today prep/additional/production/low-items + quick actions)
- Recipes (CRUD, duplicate, scaling, cost calculation, export)
- Inventory (CRUD, adjustments, low-items, count updates, transaction audit log)
- Production List (date plans, recipe targets, aggregated requirements, shortage detection)
- Grocery List (manual + shortage push, purchased/received flow, inventory auto-increase on receive)
- Prep Lists (daily + additional with one-tap status updates)
- Schedule (create/manage chef shifts)
- Users (admin-only)
- Analytics (waste summary, low items, recipe cost breakdown)
- CSV import/export for inventory + recipes

## Database Schema (Tables)
- `roles`, `users`, `auth_tokens`
- `recipes`, `recipe_ingredients`
- `inventory_items`, `inventory_transactions`
- `production_plans`, `production_plan_items`
- `grocery_lists`, `grocery_list_items`
- `prep_tasks`
- `chef_schedules`

## API Overview
- Auth: `POST /api/auth/login`, `GET /api/auth/me`
- Dashboard: `GET /api/dashboard`
- Users: `GET/POST /api/users`, `PUT /api/users/{id}`
- Staff directory: `GET /api/staff` (active staff list for prep/schedule assignment)
- Recipes: `GET/POST /api/recipes`, `GET/PUT /api/recipes/{id}`, `POST /api/recipes/{id}/duplicate`, `GET /api/recipes/{id}/scale`, `GET /api/recipes/{id}/export`
- Recipes CSV: `GET /api/recipes/export-csv`, `POST /api/recipes/import-csv`
- Inventory: `GET/POST /api/inventory`, `PUT /api/inventory/{id}`, `POST /api/inventory/{id}/adjust`, `POST /api/inventory/count`, `GET /api/inventory/low-items`, `GET /api/inventory/transactions`
- Inventory CSV: `GET /api/inventory/export-csv`, `POST /api/inventory/import-csv`
- Production: `GET/POST /api/production-plans`, `GET /api/production-plans/{id}`, `POST /api/production-plans/{id}/items`, `POST /api/production-plans/{id}/send-shortages`
- Grocery: `GET/POST /api/grocery-lists`, `GET /api/grocery-lists/{id}`, `POST /api/grocery-lists/{id}/items`, `PUT /api/grocery-items/{id}`
- Prep: `GET/POST /api/prep-tasks`, `PUT /api/prep-tasks/{id}`, `PATCH /api/prep-tasks/{id}/status`
- Schedule: `GET/POST /api/schedules`, `PUT/DELETE /api/schedules/{id}`
- Analytics: `GET /api/analytics`

## Setup (Free, Local)
1. Install Python 3.11+.
2. In project root:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
3. Run app:
   ```bash
   ./run.sh
   ```
4. Open [http://localhost:8000](http://localhost:8000)

After setup, run with one command: `./run.sh`

## First Admin User
Seeded default admin (first run):
- username: `admin`
- password: `admin123`

To create/reset an admin:
```bash
python scripts/create_admin.py --username owner --full-name "Owner" --password "ChangeMe123"
```

## Seed Data
First startup seeds:
- Users: admin, chef1, prep1
- Inventory: Tomato, Olive Oil, Chicken Breast, Garlic, Basil, Heavy Cream
- Recipes: Tomato Basil Sauce, Poached Chicken, Cream Base
- Prep tasks and sample schedules

## Notes
- SQLite data file: `kitchenos.db` (persistent local storage)
- Designed for tablet/laptop use in kitchen and mobile manager access on local network.

## CSV Formats
`Inventory CSV` headers:
`name,category,base_unit,current_quantity,par_level,reorder_threshold,cost_per_unit,supplier`

`Recipes CSV` headers:
`recipe_name,category,yield_amount,yield_unit,portion_size,instructions,ingredient_name,ingredient_quantity,ingredient_unit,ingredient_prep_note`

Recipe import requires each `ingredient_name` to already exist in `inventory_items`.
