const state = {
  token: localStorage.getItem('kitchen_token') || '',
  user: null,
  activeTab: 'dashboard',
  tabs: ['dashboard', 'recipes', 'inventory', 'production', 'grocery', 'prep', 'schedule', 'analytics', 'users'],
};

const roleCanEdit = () => ['admin', 'manager'].includes(state.user?.role);

function el(id) {
  return document.getElementById(id);
}

async function api(path, options = {}) {
  const headers = options.headers || {};
  headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data.detail || JSON.stringify(data);
    } catch (_e) {
      const text = await res.text();
      if (text) msg = text;
    }
    throw new Error(msg);
  }

  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) return res.json();
  return res.text();
}

function fmtNum(n) {
  return Number(n || 0).toFixed(2);
}

function downloadTextFile(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function pickCsvFile(onLoad) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onLoad(String(reader.result || ''));
    reader.readAsText(file);
  };
  input.click();
}

function setTabs() {
  const tabs = state.tabs.filter((t) => !(t === 'users' && state.user?.role !== 'admin'));
  el('tabs').innerHTML = tabs
    .map(
      (t) => `<button class="tab-btn ${state.activeTab === t ? 'active' : ''}" onclick="switchTab('${t}')">${t[0].toUpperCase() + t.slice(1)}</button>`
    )
    .join('');
}

function switchTab(tab) {
  state.activeTab = tab;
  for (const pane of document.querySelectorAll('.tab-pane')) pane.classList.add('hidden');
  el(tab).classList.remove('hidden');
  setTabs();
  refreshActiveTab();
}

async function login() {
  try {
    const payload = { username: el('loginUser').value.trim(), password: el('loginPass').value };
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('kitchen_token', state.token);
    el('loginView').classList.add('hidden');
    el('appView').classList.remove('hidden');
    el('sessionInfo').textContent = `${data.user.full_name} (${data.user.role})`;
    setTabs();
    switchTab('dashboard');
  } catch (err) {
    alert(`Login failed: ${err.message}`);
  }
}

function logout() {
  state.token = '';
  state.user = null;
  localStorage.removeItem('kitchen_token');
  el('loginView').classList.remove('hidden');
  el('appView').classList.add('hidden');
}

async function bootSession() {
  if (!state.token) return;
  try {
    const me = await api('/api/auth/me');
    state.user = me;
    el('loginView').classList.add('hidden');
    el('appView').classList.remove('hidden');
    el('sessionInfo').textContent = `${me.full_name} (${me.role})`;
    setTabs();
    switchTab('dashboard');
  } catch (_err) {
    logout();
  }
}

async function refreshActiveTab() {
  if (!state.user) return;
  try {
    if (state.activeTab === 'dashboard') await renderDashboard();
    if (state.activeTab === 'recipes') await renderRecipes();
    if (state.activeTab === 'inventory') await renderInventory();
    if (state.activeTab === 'production') await renderProduction();
    if (state.activeTab === 'grocery') await renderGrocery();
    if (state.activeTab === 'prep') await renderPrep();
    if (state.activeTab === 'schedule') await renderSchedule();
    if (state.activeTab === 'users') await renderUsers();
    if (state.activeTab === 'analytics') await renderAnalytics();
  } catch (err) {
    alert(err.message);
  }
}

async function renderDashboard() {
  const data = await api('/api/dashboard');
  el('dashboard').innerHTML = `
    <div class="grid two">
      <div class="card">
        <h3>Quick Actions</h3>
        <div class="row wrap gap">
          ${roleCanEdit() ? '<button class="btn btn-lg" onclick="quickAddTask(\'daily\')">Add Prep Task</button>' : ''}
          ${roleCanEdit() ? '<button class="btn btn-lg" onclick="quickAddTask(\'additional\')">Add Additional Task</button>' : ''}
          ${roleCanEdit() ? '<button class="btn btn-lg" onclick="quickAddGrocery()">Add Grocery Item</button>' : ''}
          <button class="btn btn-lg" onclick="quickAdjustInventory()">Adjust Inventory</button>
        </div>
        ${
          roleCanEdit()
            ? ''
            : '<small>You are signed in as prep. Recipe/production/task creation requires Admin or Manager role.</small>'
        }
      </div>
      <div class="card">
        <h3>Low Items (${data.low_items.length})</h3>
        ${data.low_items.map((x) => `<div class="line"><b>${x.name}</b> ${fmtNum(x.current_quantity)} ${x.base_unit} / par ${fmtNum(x.par_level)}</div>`).join('') || '<p>None</p>'}
      </div>
    </div>
    <div class="grid two">
      <div class="card"><h3>Today's Prep List</h3>${renderTaskList(data.prep_daily)}</div>
      <div class="card"><h3>Additional Prep List</h3>${renderTaskList(data.prep_additional)}</div>
    </div>
    <div class="grid two">
      <div class="card"><h3>Production List</h3>
        ${data.production_list.map((p) => `<div class="line">${p.recipe_name} - target ${fmtNum(p.target_yield_amount)} ${p.yield_unit}</div>`).join('') || '<p>No production plan</p>'}
      </div>
      <div class="card"><h3>Shortages</h3>
        ${data.shortages.map((s) => `<div class="line warning">${s.name}: shortage ${fmtNum(s.shortage_quantity)} ${s.unit}</div>`).join('') || '<p>No shortages</p>'}
      </div>
    </div>
  `;
}

function renderTaskList(tasks) {
  if (!tasks.length) return '<p>No tasks</p>';
  return tasks
    .map(
      (t) =>
        `<div class="task-row ${t.status}">
          <div>
            <b class="${t.status === 'done' ? 'done-text' : ''}">${t.status === 'done' ? '✓ ' : ''}${t.title}</b><br>
            <small>${t.priority}${t.due_time ? ' | ' + t.due_time : ''}</small>
          </div>
          ${
            t.status === 'done'
              ? `<div class="row gap"><button class="btn" disabled>Done</button><button class="btn danger" onclick="removePrepTask(${t.id})">Remove</button></div>`
              : `<button class="btn" onclick="markTaskDone(${t.id})">Mark Done</button>`
          }
        </div>`
    )
    .join('');
}

async function markTaskDone(id) {
  await api(`/api/prep-tasks/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  await refreshActiveTab();
}

async function removePrepTask(id) {
  await api(`/api/prep-tasks/${id}`, { method: 'DELETE' });
  await refreshActiveTab();
}

async function quickAddTask(listType) {
  const title = prompt('Task title');
  if (!title) return;
  await api('/api/prep-tasks', {
    method: 'POST',
    body: JSON.stringify({ title, list_type: listType, priority: 'med', status: 'todo' }),
  });
  await refreshActiveTab();
}

async function quickAddGrocery() {
  const lists = await api('/api/grocery-lists');
  let listId = lists[0]?.id;
  if (!listId) {
    const created = await api('/api/grocery-lists', { method: 'POST', body: JSON.stringify({}) });
    listId = created.id;
  }
  const name = prompt('Grocery item name');
  if (!name) return;
  const qty = Number(prompt('Quantity', '1') || '1');
  const unit = prompt('Unit', 'kg') || 'kg';
  await api(`/api/grocery-lists/${listId}/items`, {
    method: 'POST',
    body: JSON.stringify({ name, quantity: qty, unit }),
  });
  alert('Added to grocery list');
}

async function quickAdjustInventory() {
  const items = await api('/api/inventory');
  const names = items.map((x) => `${x.id}:${x.name}`).join('\n');
  const id = Number(prompt(`Enter inventory item id:\n${names}`));
  if (!id) return;
  const change = Number(prompt('Change quantity (+/-)', '-1'));
  const reason = prompt('Reason (waste/received/counted/transferred/adjustment)', 'adjustment') || 'adjustment';
  await api(`/api/inventory/${id}/adjust`, {
    method: 'POST',
    body: JSON.stringify({ change_quantity: change, reason, source: 'quick_action' }),
  });
  await refreshActiveTab();
}

async function renderRecipes() {
  const [recipes, inventory] = await Promise.all([api('/api/recipes'), api('/api/inventory')]);
  el('recipes').innerHTML = `
    <div class="card">
      <div class="row between">
        <h3>Recipes</h3>
        <div class="row gap">
          ${roleCanEdit() ? '<button class="btn" onclick="openRecipeForm()">Create Recipe</button>' : ''}
          <button class="btn" onclick="exportRecipesCsv()">Export CSV</button>
          ${roleCanEdit() ? '<button class="btn" onclick="importRecipesCsv()">Import CSV</button>' : ''}
          <button class="btn" onclick="window.print()">Print</button>
        </div>
      </div>
      ${!roleCanEdit() ? '<p><small>Prep role is read-only for recipes. Use Admin/Manager account to create/edit.</small></p>' : ''}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Category</th><th>Yield</th><th>Cost</th><th>Actions</th></tr></thead>
          <tbody>
            ${recipes
              .map(
                (r) => `<tr>
                  <td>${r.name}</td>
                  <td>${r.category}</td>
                  <td>${fmtNum(r.yield_amount)} ${r.yield_unit}</td>
                  <td>$${fmtNum(r.cost_total)}</td>
                  <td>
                    <button class="btn" onclick="viewRecipe(${r.id})">View</button>
                    ${roleCanEdit() ? `<button class="btn" onclick="editRecipe(${r.id})">Edit</button>` : ''}
                    ${roleCanEdit() ? `<button class="btn" onclick="duplicateRecipe(${r.id})">Duplicate</button>` : ''}
                    ${roleCanEdit() ? `<button class="btn danger" onclick="deleteRecipe(${r.id})">Delete</button>` : ''}
                    <button class="btn" onclick="scaleRecipe(${r.id})">Scale</button>
                    <button class="btn" onclick="exportRecipe(${r.id})">Export</button>
                  </td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div id="recipeDetails"></div>
    </div>
  `;

  window.openRecipeForm = async function () {
    const name = (prompt('Recipe name') || '').trim();
    if (!name) return;
    const category = (prompt('Category', 'prep') || 'prep').trim();
    const yield_amount = Number(prompt('Yield amount (>0)', '1'));
    if (!Number.isFinite(yield_amount) || yield_amount <= 0) {
      alert('Yield amount must be greater than 0');
      return;
    }
    const yield_unit = (prompt('Yield unit', 'kg') || 'kg').trim();
    const instructions = prompt('Instructions', '1) Prep\n2) Cook') || '';

    const inventoryLines = inventory.map((i) => `${i.id}:${i.name}(${i.base_unit})`).join('\n');
    const ingredients = [];
    while (true) {
      const idVal = prompt(`Ingredient inventory ID (Cancel to stop):\n${inventoryLines}`);
      if (!idVal) break;
      const inv = inventory.find((x) => x.id === Number(idVal));
      if (!inv) {
        alert('Invalid inventory ID');
        continue;
      }
      const quantity = Number(prompt(`Quantity for ${inv.name}`, '1'));
      if (!Number.isFinite(quantity) || quantity < 0) {
        alert('Quantity must be a non-negative number');
        continue;
      }
      const prep_note = prompt('Prep note', '') || '';
      ingredients.push({ inventory_item_id: inv.id, quantity, unit: inv.base_unit, prep_note });
    }

    await api('/api/recipes', {
      method: 'POST',
      body: JSON.stringify({ name, category, yield_amount, yield_unit, instructions, ingredients }),
    });
    alert('Recipe created');
    await refreshActiveTab();
  };

  window.editRecipe = async function (id) {
    const r = await api(`/api/recipes/${id}`);
    const name = (prompt('Recipe name', r.name) || '').trim();
    if (!name) return;
    const category = (prompt('Category', r.category) || r.category).trim();
    const yield_amount = Number(prompt('Yield amount (>0)', String(r.yield_amount)));
    if (!Number.isFinite(yield_amount) || yield_amount <= 0) {
      alert('Yield amount must be greater than 0');
      return;
    }
    const yield_unit = (prompt('Yield unit', r.yield_unit) || r.yield_unit).trim();
    const portion_size = prompt('Portion size', r.portion_size || '') || '';
    const instructions = prompt('Instructions', r.instructions || '') || '';
    await api(`/api/recipes/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name,
        category,
        yield_amount,
        yield_unit,
        portion_size,
        instructions,
        ingredients: r.ingredients.map((i) => ({
          inventory_item_id: i.inventory_item_id,
          quantity: i.quantity,
          unit: i.unit,
          prep_note: i.prep_note || '',
        })),
      }),
    });
    alert('Recipe updated');
    await refreshActiveTab();
  };

  window.deleteRecipe = async function (id) {
    if (!confirm('Delete this recipe?')) return;
    await api(`/api/recipes/${id}`, { method: 'DELETE' });
    alert('Recipe deleted');
    await refreshActiveTab();
  };

  window.viewRecipe = async function (id) {
    const r = await api(`/api/recipes/${id}`);
    const ing = r.ingredients
      .map((i) => `<li>${i.ingredient_name}: ${fmtNum(i.quantity)} ${i.unit} ${i.prep_note ? `(${i.prep_note})` : ''}</li>`)
      .join('');
    el('recipeDetails').innerHTML = `
      <div class="card mt">
        <h4>${r.name}</h4>
        <p><b>Category:</b> ${r.category} | <b>Yield:</b> ${fmtNum(r.yield_amount)} ${r.yield_unit} | <b>Cost:</b> $${fmtNum(r.cost_total)}</p>
        <ul>${ing}</ul>
        <pre>${r.instructions}</pre>
      </div>
    `;
  };

  window.scaleRecipe = async function (id) {
    const target = Number(prompt('Target yield amount', '1'));
    if (!target) return;
    const scaled = await api(`/api/recipes/${id}/scale?target_yield=${target}`);
    alert(scaled.scaled_ingredients.map((x) => `${x.ingredient}: ${fmtNum(x.quantity)} ${x.unit}`).join('\n'));
  };

  window.exportRecipe = async function (id) {
    const txt = await api(`/api/recipes/${id}/export`);
    alert(txt);
  };

  window.duplicateRecipe = async function (id) {
    await api(`/api/recipes/${id}/duplicate`, { method: 'POST', body: '{}' });
    await refreshActiveTab();
  };

  window.exportRecipesCsv = async function () {
    const csv = await api('/api/recipes/export-csv');
    downloadTextFile('recipes_export.csv', csv, 'text/csv');
  };

  window.importRecipesCsv = async function () {
    pickCsvFile(async (csvText) => {
      const res = await api('/api/recipes/import-csv', {
        method: 'POST',
        body: JSON.stringify({ csv: csvText }),
      });
      alert(`Imported ${res.imported_recipes} recipes`);
      await refreshActiveTab();
    });
  };
}

async function renderInventory() {
  const [items, lowItems, tx] = await Promise.all([
    api('/api/inventory'),
    api('/api/inventory/low-items'),
    api('/api/inventory/transactions?limit=20'),
  ]);
  el('inventory').innerHTML = `
    <div class="grid two">
      <div class="card">
        <div class="row between">
          <h3>Inventory</h3>
          <div class="row gap">
            ${roleCanEdit() ? '<button class="btn" onclick="createInventoryItem()">Add Item</button>' : ''}
            <button class="btn" onclick="exportInventoryCsv()">Export CSV</button>
            ${roleCanEdit() ? '<button class="btn" onclick="importInventoryCsv()">Import CSV</button>' : ''}
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Item</th><th>Qty</th><th>Par</th><th>Reorder</th><th>Cost/u</th><th>Actions</th></tr></thead>
            <tbody>
              ${items
                .map(
                  (i) => `<tr>
                    <td>${i.name}<br><small>${i.category}</small></td>
                    <td>${fmtNum(i.current_quantity)} ${i.base_unit}</td>
                    <td>${fmtNum(i.par_level)}</td>
                    <td>${fmtNum(i.reorder_threshold)}</td>
                    <td>$${fmtNum(i.cost_per_unit)}</td>
                    <td><button class="btn" onclick="adjustItem(${i.id})">Adjust</button></td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h3>Low Items (${lowItems.length})</h3>
        ${lowItems.map((i) => `<div class="line warning">${i.name}: ${fmtNum(i.current_quantity)} ${i.base_unit}</div>`).join('') || '<p>None</p>'}
        <h3 class="mt">Recent Inventory Log</h3>
        ${tx.map((x) => `<div class="line"><b>${x.item_name}</b> ${x.change_quantity > 0 ? '+' : ''}${fmtNum(x.change_quantity)} (${x.reason})</div>`).join('') || '<p>No transactions</p>'}
      </div>
    </div>
  `;

  window.adjustItem = async function (id) {
    const change = Number(prompt('Change quantity (+/-)', '-1'));
    const reason = prompt('Reason', 'adjustment') || 'adjustment';
    await api(`/api/inventory/${id}/adjust`, {
      method: 'POST',
      body: JSON.stringify({ change_quantity: change, reason, source: 'inventory_tab' }),
    });
    await refreshActiveTab();
  };

  window.createInventoryItem = async function () {
    const name = prompt('Item name');
    if (!name) return;
    const category = prompt('Category', 'Produce') || 'Produce';
    const base_unit = prompt('Base unit', 'kg') || 'kg';
    const current_quantity = Number(prompt('Current quantity', '0'));
    const par_level = Number(prompt('Par level', '0'));
    const reorder_threshold = Number(prompt('Reorder threshold', '0'));
    const cost_per_unit = Number(prompt('Cost per unit', '0'));
    const supplier = prompt('Supplier', '') || '';

    await api('/api/inventory', {
      method: 'POST',
      body: JSON.stringify({
        name,
        category,
        base_unit,
        current_quantity,
        par_level,
        reorder_threshold,
        cost_per_unit,
        supplier,
      }),
    });
    await refreshActiveTab();
  };

  window.exportInventoryCsv = async function () {
    const csv = await api('/api/inventory/export-csv');
    downloadTextFile('inventory_export.csv', csv, 'text/csv');
  };

  window.importInventoryCsv = async function () {
    pickCsvFile(async (csvText) => {
      const res = await api('/api/inventory/import-csv', {
        method: 'POST',
        body: JSON.stringify({ csv: csvText }),
      });
      alert(`Imported ${res.imported_items} inventory items`);
      await refreshActiveTab();
    });
  };
}

async function renderProduction() {
  const today = new Date().toISOString().slice(0, 10);
  const [plans, recipes] = await Promise.all([api(`/api/production-plans?plan_date=${today}`), api('/api/recipes')]);
  let plan = plans[0];
  if (!plan && roleCanEdit()) {
    const created = await api('/api/production-plans', { method: 'POST', body: JSON.stringify({ plan_date: today, name: 'Today Plan' }) });
    plan = { id: created.id };
  }

  let planData = null;
  if (plan) planData = await api(`/api/production-plans/${plan.id}`);

  el('production').innerHTML = `
    <div class="card">
      <div class="row between">
        <h3>Production Plan (${today})</h3>
        <div class="row gap">
          ${roleCanEdit() ? '<button class="btn" onclick="addPlanItem()">Add Production</button>' : ''}
          ${roleCanEdit() ? '<button class="btn" onclick="sendShortages()">Send Shortages to Grocery</button>' : ''}
          <button class="btn" onclick="window.print()">Print</button>
        </div>
      </div>
      ${!roleCanEdit() ? '<p><small>Prep role can view production only. Use Admin/Manager account to create plans.</small></p>' : ''}
      ${
        !planData
          ? '<p>No plan for today</p>'
          : `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Recipe</th><th>Target Yield</th></tr></thead>
            <tbody>
              ${planData.items.map((x) => `<tr><td>${x.recipe_name}</td><td>${fmtNum(x.target_yield_amount)} ${x.yield_unit}</td></tr>`).join('') || '<tr><td colspan="2">No items</td></tr>'}
            </tbody>
          </table>
        </div>
        <h4 class="mt">Ingredient Requirements</h4>
        ${planData.requirements
          .map(
            (r) => `<div class="line ${r.shortage_quantity > 0 ? 'warning' : ''}">
            ${r.name}: required ${fmtNum(r.required_quantity)} ${r.unit}, available ${fmtNum(r.available_quantity)}
            ${r.shortage_quantity > 0 ? `, shortage ${fmtNum(r.shortage_quantity)}` : ''}
          </div>`
          )
          .join('') || '<p>No requirements</p>'}
      `
      }
    </div>
  `;

  window.addPlanItem = async function () {
    if (!plan) return;
    const list = recipes.map((r) => `${r.id}:${r.name} (${fmtNum(r.yield_amount)} ${r.yield_unit})`).join('\n');
    const recipe_id = Number(prompt(`Select recipe ID for production:\n${list}`));
    if (!recipe_id) return;
    const target_yield_amount = Number(prompt('Target yield amount', '1'));
    if (!Number.isFinite(target_yield_amount) || target_yield_amount <= 0) {
      alert('Target yield amount must be greater than 0');
      return;
    }
    await api(`/api/production-plans/${plan.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ recipe_id, target_yield_amount }),
    });
    alert('Production item added');
    await refreshActiveTab();
  };

  window.sendShortages = async function () {
    if (!plan) return;
    const res = await api(`/api/production-plans/${plan.id}/send-shortages`, { method: 'POST', body: '{}' });
    alert(`Added ${res.added} shortages to grocery list #${res.grocery_list_id || '-'}`);
    await refreshActiveTab();
  };
}

async function renderGrocery() {
  const today = new Date().toISOString().slice(0, 10);
  const lists = await api(`/api/grocery-lists?list_date=${today}`);
  let list = lists[0];
  if (!list && roleCanEdit()) {
    const created = await api('/api/grocery-lists', { method: 'POST', body: JSON.stringify({ list_date: today }) });
    list = { id: created.id };
  }

  const detail = list ? await api(`/api/grocery-lists/${list.id}`) : null;
  el('grocery').innerHTML = `
    <div class="card">
      <div class="row between">
        <h3>Grocery List (${today})</h3>
        <div class="row gap">
          ${roleCanEdit() ? '<button class="btn" onclick="addGroceryItem()">Manual Add</button>' : ''}
          <button class="btn" onclick="window.print()">Print</button>
        </div>
      </div>
      ${
        !detail
          ? '<p>No grocery list</p>'
          : `<div class="table-wrap"><table>
          <thead><tr><th>Item</th><th>Qty</th><th>Vendor</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${detail.items
              .map(
                (i) => `<tr>
                <td>${i.name}</td>
                <td>${fmtNum(i.quantity)} ${i.unit}</td>
                <td>${i.vendor || '-'}</td>
                <td>${i.status}</td>
                <td>
                  <button class="btn" onclick="setGroceryStatus(${i.id}, 'purchased')">Purchased</button>
                  <button class="btn" onclick="setGroceryStatus(${i.id}, 'received')">Received</button>
                </td>
              </tr>`
              )
              .join('') || '<tr><td colspan="5">No items</td></tr>'}
          </tbody>
        </table></div>`
      }
    </div>
  `;

  window.setGroceryStatus = async function (id, status) {
    await api(`/api/grocery-items/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
    await refreshActiveTab();
  };

  window.addGroceryItem = async function () {
    if (!list) return;
    const name = prompt('Item name');
    if (!name) return;
    const quantity = Number(prompt('Quantity', '1'));
    const unit = prompt('Unit', 'kg') || 'kg';
    const vendor = prompt('Vendor', '') || '';
    await api(`/api/grocery-lists/${list.id}/items`, { method: 'POST', body: JSON.stringify({ name, quantity, unit, vendor }) });
    await refreshActiveTab();
  };
}

async function renderPrep() {
  const today = new Date().toISOString().slice(0, 10);
  const [tasks, users, recipes] = await Promise.all([api(`/api/prep-tasks?task_date=${today}`), api('/api/staff').catch(() => []), api('/api/recipes')]);
  const daily = tasks.filter((t) => t.list_type === 'daily');
  const additional = tasks.filter((t) => t.list_type === 'additional');
  el('prep').innerHTML = `
    <div class="card">
      <div class="row between">
        <h3>Prep Lists (${today})</h3>
        ${roleCanEdit() ? '<button class="btn" onclick="addPrepTask()">Add Task</button>' : ''}
      </div>
      <div class="grid two">
        <div><h4>Prep List for the Day</h4>${renderPrepTable(daily)}</div>
        <div><h4>Additional Prep List</h4>${renderPrepTable(additional)}</div>
      </div>
    </div>
  `;

  window.updatePrepStatus = async function (id, status) {
    await api(`/api/prep-tasks/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    await refreshActiveTab();
  };

  window.addPrepTask = async function () {
    const title = (prompt('Task title') || '').trim();
    if (!title) return;
    const typeInput = (prompt('List type (daily/additional)', 'daily') || 'daily').trim().toLowerCase();
    const type = typeInput === 'additional' ? 'additional' : 'daily';
    const priority = prompt('Priority (low/med/high)', 'med') || 'med';
    const recipeList = recipes.map((r) => `${r.id}:${r.name}`).join('\n');
    const recipe_id = Number(prompt(`Linked recipe id (optional)\n${recipeList}`) || '0') || null;
    const assignedText = users.map((u) => `${u.id}:${u.full_name}`).join('\n');
    const assigned_to = Number(prompt(`Assign to user id (optional)\n${assignedText}`) || '0') || null;
    const due_time = prompt('Due time HH:MM', '') || null;
    const notes = prompt('Notes', '') || '';
    await api('/api/prep-tasks', {
      method: 'POST',
      body: JSON.stringify({ title, list_type: type, priority, recipe_id, assigned_to, due_time, notes }),
    });
    alert('Task added');
    await refreshActiveTab();
  };
}

function renderPrepTable(rows) {
  if (!rows.length) return '<p>No tasks</p>';
  return `<div class="table-wrap"><table>
      <thead><tr><th>Task</th><th>Priority</th><th>Status</th><th>Assigned</th><th>Action</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (t) => `<tr class="${t.status === 'done' ? 'done-row' : ''}">
            <td><b class="${t.status === 'done' ? 'done-text' : ''}">${t.status === 'done' ? '✓ ' : ''}${t.title}</b><br><small>${t.notes || ''}</small></td>
            <td>${t.priority}</td>
            <td>${t.status}</td>
            <td>${t.assigned_name || '-'}</td>
            <td>
              <button class="btn" onclick="updatePrepStatus(${t.id}, 'todo')">To Do</button>
              <button class="btn" onclick="updatePrepStatus(${t.id}, 'in_progress')">In Progress</button>
              <button class="btn" onclick="updatePrepStatus(${t.id}, 'done')">Done</button>
              ${t.status === 'done' ? `<button class="btn danger" onclick="removePrepTask(${t.id})">Remove</button>` : ''}
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table></div>`;
}

async function renderSchedule() {
  const [users, schedules] = await Promise.all([api('/api/staff').catch(() => []), api('/api/schedules')]);
  el('schedule').innerHTML = `
    <div class="card">
      <div class="row between">
        <h3>Chef Schedule</h3>
        ${roleCanEdit() ? '<button class="btn" onclick="addSchedule()">Add Shift</button>' : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Chef</th><th>Shift</th><th>Station</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
          <tbody>
            ${schedules
              .map(
                (s) => `<tr>
                <td>${s.shift_date}</td>
                <td>${s.chef_name}</td>
                <td>${s.start_time} - ${s.end_time}</td>
                <td>${s.station || '-'}</td>
                <td>${s.status}</td>
                <td>${s.notes || '-'}</td>
                <td>
                  ${roleCanEdit() ? `<button class="btn" onclick="editSchedule(${s.id})">Edit</button>` : ''}
                  ${roleCanEdit() ? `<button class="btn danger" onclick="deleteSchedule(${s.id})">Delete</button>` : ''}
                </td>
              </tr>`
              )
              .join('') || '<tr><td colspan="7">No shifts</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;

  window.addSchedule = async function () {
    const chefList = users.map((u) => `${u.id}:${u.full_name}(${u.role})`).join('\n');
    const user_id = Number(prompt(`Chef user id:\n${chefList}`));
    if (!user_id) return;
    const shift_date = prompt('Date YYYY-MM-DD', new Date().toISOString().slice(0, 10));
    const start_time = prompt('Start HH:MM', '09:00');
    const end_time = prompt('End HH:MM', '17:00');
    const station = prompt('Station', 'Prep') || '';
    const notes = prompt('Notes', '') || '';
    await api('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({ user_id, shift_date, start_time, end_time, station, notes, status: 'scheduled' }),
    });
    await refreshActiveTab();
  };

  window.editSchedule = async function (id) {
    const row = schedules.find((s) => s.id === id);
    if (!row) return;
    const chefList = users.map((u) => `${u.id}:${u.full_name}(${u.role})`).join('\n');
    const user_id = Number(prompt(`Chef user id:\n${chefList}`, String(row.user_id)));
    const shift_date = prompt('Date YYYY-MM-DD', row.shift_date);
    const start_time = prompt('Start HH:MM', row.start_time);
    const end_time = prompt('End HH:MM', row.end_time);
    const station = prompt('Station', row.station || '') || '';
    const notes = prompt('Notes', row.notes || '') || '';
    const status = prompt('Status (scheduled/confirmed/cancelled)', row.status) || row.status;
    await api(`/api/schedules/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ user_id, shift_date, start_time, end_time, station, notes, status }),
    });
    await refreshActiveTab();
  };

  window.deleteSchedule = async function (id) {
    if (!confirm('Delete this shift?')) return;
    await api(`/api/schedules/${id}`, { method: 'DELETE' });
    await refreshActiveTab();
  };
}

async function renderUsers() {
  if (state.user?.role !== 'admin') {
    el('users').innerHTML = '<div class="card"><p>Admin only.</p></div>';
    return;
  }
  const users = await api('/api/users');
  el('users').innerHTML = `
    <div class="card">
      <div class="row between">
        <h3>Users</h3>
        <button class="btn" onclick="createUser()">Create User</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Active</th></tr></thead>
        <tbody>${users.map((u) => `<tr><td>${u.username}</td><td>${u.full_name}</td><td>${u.role}</td><td>${u.active ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>
  `;

  window.createUser = async function () {
    const username = (prompt('Username') || '').trim();
    if (!username) return;
    const full_name = prompt('Full name') || username;
    const roleInput = (prompt('Role (admin/manager/prep/chef/prep chef)', 'prep') || 'prep').trim().toLowerCase();
    const roleMap = {
      admin: 'admin',
      owner: 'admin',
      chef: 'manager',
      manager: 'manager',
      'chef manager': 'manager',
      prep: 'prep',
      'prep chef': 'prep',
    };
    const role = roleMap[roleInput] || roleInput;
    const password = prompt('Password', 'admin123') || 'admin123';
    await api('/api/users', { method: 'POST', body: JSON.stringify({ username, full_name, role, password }) });
    alert('User created');
    await refreshActiveTab();
  };
}

async function renderAnalytics() {
  const a = await api('/api/analytics');
  el('analytics').innerHTML = `
    <div class="grid two">
      <div class="card">
        <h3>Waste Summary</h3>
        ${a.waste_summary.map((w) => `<div class="line">${w.name}: ${fmtNum(w.waste_qty)}</div>`).join('') || '<p>No waste yet</p>'}
      </div>
      <div class="card">
        <h3>Top Low Items</h3>
        ${a.top_low_items.map((x) => `<div class="line">${x.name}: ${fmtNum(x.current_quantity)} (reorder ${fmtNum(x.reorder_threshold)})</div>`).join('')}
      </div>
    </div>
    <div class="card">
      <h3>Recipe Cost Breakdown</h3>
      ${a.recipe_cost_breakdown.map((r) => `<div class="line">${r.recipe}: $${fmtNum(r.cost)} per ${r.yield}</div>`).join('')}
    </div>
  `;
}

bootSession();
