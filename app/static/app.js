const state = {
  token: localStorage.getItem('kitchen_token') || '',
  user: null,
  activeTab: 'dashboard',
  tabs: ['dashboard', 'recipes', 'inventory', 'production', 'grocery', 'prep', 'schedule', 'analytics', 'users'],
  recipeFormInventory: [],
  appFormSubmit: null,
};

const roleCanEdit = () => ['admin', 'manager'].includes(state.user?.role);
const tabMeta = {
  dashboard: { label: 'Dashboard', shortLabel: 'Home' },
  recipes: { label: 'Recipes', shortLabel: 'Recipes' },
  inventory: { label: 'Inventory', shortLabel: 'Stock' },
  production: { label: 'Production', shortLabel: 'Runs' },
  grocery: { label: 'Grocery', shortLabel: 'Buy' },
  prep: { label: 'Prep', shortLabel: 'Prep' },
  schedule: { label: 'Schedule', shortLabel: 'Shifts' },
  analytics: { label: 'Analytics', shortLabel: 'Stats' },
  users: { label: 'Users', shortLabel: 'Users' },
};

function el(id) {
  return document.getElementById(id);
}

function showToast(message, type = 'info') {
  const container = el('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 220);
  }, 2800);
}

function renderLoadingState(tab) {
  const pane = el(tab);
  if (!pane) return;
  pane.innerHTML = `
    <div class="card skeleton-card">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line short"></div>
    </div>
  `;
}

function renderErrorState(tab, message) {
  const pane = el(tab);
  if (!pane) return;
  pane.innerHTML = `
    <div class="card error-state">
      <h3>Something went wrong</h3>
      <p>${message}</p>
      <button class="btn" onclick="refreshActiveTab()">Retry</button>
    </div>
  `;
}

function enhanceResponsiveTables(root = document) {
  root.querySelectorAll('table').forEach((table) => {
    const labels = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent?.trim() || '');
    table.classList.add('responsive-table');
    table.querySelectorAll('tbody tr').forEach((tr) => {
      Array.from(tr.children).forEach((cell, idx) => {
        if (!cell.getAttribute('data-label')) cell.setAttribute('data-label', labels[idx] || '');
      });
    });
  });
}

function closeMobileSidebar() {
  el('appSidebar')?.classList.remove('open');
}

function setupShellInteractions() {
  const menuBtn = el('menuToggle');
  if (menuBtn && !menuBtn.dataset.bound) {
    menuBtn.dataset.bound = '1';
    menuBtn.addEventListener('click', () => {
      el('appSidebar')?.classList.toggle('open');
    });
  }
}

function toggleFilterPanel(panelId) {
  const panel = el(panelId);
  if (!panel) return;
  panel.classList.toggle('hidden');
}

function filterTableRows(tableId, query) {
  const q = (query || '').trim().toLowerCase();
  const table = el(tableId);
  if (!table) return;
  table.querySelectorAll('tbody tr').forEach((row) => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(q) ? '' : 'none';
  });
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getRecipeFormModal() {
  return el('recipeFormModal');
}

function closeRecipeFormModal() {
  const modal = getRecipeFormModal();
  if (!modal) return;
  modal.classList.add('hidden');
  modal.dataset.mode = '';
  modal.dataset.recipeId = '';
}

function renderRecipeIngredientRows(ingredients = []) {
  const rowsRoot = el('recipeIngredientRows');
  if (!rowsRoot) return;
  if (!ingredients.length) {
    rowsRoot.innerHTML = '<p><small>No ingredients added yet. Use "Add Ingredient" to build the recipe.</small></p>';
    return;
  }

  const options = state.recipeFormInventory
    .map(
      (item) =>
        `<option value="${item.id}">${escapeHtml(item.name)} (${escapeHtml(item.base_unit)})</option>`
    )
    .join('');

  rowsRoot.innerHTML = ingredients
    .map(
      (ingredient, idx) => `
        <div class="ingredient-row" data-index="${idx}">
          <div>
            <label>Inventory item</label>
            <select class="ingredient-item-select">
              <option value="">Choose an inventory item</option>
              ${options}
            </select>
          </div>
          <div>
            <label>Quantity</label>
            <input class="ingredient-qty-input" type="number" min="0" step="0.01" value="${escapeHtml(ingredient.quantity ?? '')}" />
          </div>
          <div>
            <label>Unit</label>
            <input class="ingredient-unit-input" value="${escapeHtml(ingredient.unit ?? '')}" placeholder="kg" />
          </div>
          <div>
            <label>Prep note</label>
            <input class="ingredient-note-input" value="${escapeHtml(ingredient.prep_note ?? '')}" placeholder="Diced, toasted, chilled..." />
          </div>
          <button class="btn danger remove-ingredient-btn" type="button">Remove</button>
        </div>
      `
    )
    .join('');

  Array.from(rowsRoot.querySelectorAll('.ingredient-row')).forEach((row, idx) => {
    const ingredient = ingredients[idx] || {};
    const select = row.querySelector('.ingredient-item-select');
    const unitInput = row.querySelector('.ingredient-unit-input');
    if (select) {
      select.value = ingredient.inventory_item_id ? String(ingredient.inventory_item_id) : '';
      select.addEventListener('change', () => {
        const selected = state.recipeFormInventory.find((item) => item.id === Number(select.value));
        if (selected && unitInput && !unitInput.value.trim()) unitInput.value = selected.base_unit || '';
      });
    }
    row.querySelector('.remove-ingredient-btn')?.addEventListener('click', () => {
      const current = collectRecipeIngredientDraft();
      current.splice(idx, 1);
      renderRecipeIngredientRows(current);
    });
  });
}

function collectRecipeIngredientDraft() {
  const rows = Array.from(document.querySelectorAll('#recipeIngredientRows .ingredient-row'));
  return rows.map((row) => ({
    inventory_item_id: Number(row.querySelector('.ingredient-item-select')?.value || '0') || null,
    quantity: row.querySelector('.ingredient-qty-input')?.value || '',
    unit: row.querySelector('.ingredient-unit-input')?.value || '',
    prep_note: row.querySelector('.ingredient-note-input')?.value || '',
  }));
}

function addRecipeIngredientRow() {
  const current = collectRecipeIngredientDraft();
  current.push({ inventory_item_id: null, quantity: '', unit: '', prep_note: '' });
  renderRecipeIngredientRows(current);
}

function getRecipeFormPayload() {
  const name = (el('recipeNameInput')?.value || '').trim();
  const category = (el('recipeCategoryInput')?.value || 'prep').trim() || 'prep';
  const yield_amount = Number(el('recipeYieldAmountInput')?.value || '0');
  const yield_unit = (el('recipeYieldUnitInput')?.value || 'kg').trim() || 'kg';
  const portion_size = (el('recipePortionSizeInput')?.value || '').trim();
  const instructions = el('recipeInstructionsInput')?.value || '';

  if (!name) throw new Error('Recipe name is required');
  if (!Number.isFinite(yield_amount) || yield_amount <= 0) throw new Error('Yield amount must be greater than 0');

  const ingredients = collectRecipeIngredientDraft()
    .filter((item) => item.inventory_item_id || String(item.quantity).trim() || item.prep_note.trim() || item.unit.trim())
    .map((item) => {
      const quantity = Number(item.quantity || '0');
      if (!item.inventory_item_id) throw new Error('Each ingredient row needs an inventory item');
      if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Ingredient quantity must be a non-negative number');
      const selected = state.recipeFormInventory.find((inv) => inv.id === Number(item.inventory_item_id));
      return {
        inventory_item_id: Number(item.inventory_item_id),
        quantity,
        unit: item.unit.trim() || selected?.base_unit || '',
        prep_note: item.prep_note.trim(),
      };
    });

  return {
    name,
    category,
    yield_amount,
    yield_unit,
    portion_size: portion_size || null,
    instructions,
    ingredients,
  };
}

function openRecipeFormModal({ mode, recipe = null, inventory = [] }) {
  state.recipeFormInventory = inventory;
  const modal = getRecipeFormModal();
  if (!modal) return;

  modal.dataset.mode = mode;
  modal.dataset.recipeId = recipe?.id ? String(recipe.id) : '';
  el('recipeFormTitle').textContent = mode === 'edit' ? `Edit ${recipe?.name || 'Recipe'}` : 'Create Recipe';
  el('recipeFormSubmit').textContent = mode === 'edit' ? 'Save Changes' : 'Create Recipe';
  el('recipeNameInput').value = recipe?.name || '';
  el('recipeCategoryInput').value = recipe?.category || 'prep';
  el('recipeYieldAmountInput').value = recipe?.yield_amount ?? 1;
  el('recipeYieldUnitInput').value = recipe?.yield_unit || 'kg';
  el('recipePortionSizeInput').value = recipe?.portion_size || '';
  el('recipeInstructionsInput').value = recipe?.instructions || '';
  renderRecipeIngredientRows(
    recipe?.ingredients?.map((item) => ({
      inventory_item_id: item.inventory_item_id,
      quantity: item.quantity,
      unit: item.unit,
      prep_note: item.prep_note || '',
    })) || []
  );
  modal.classList.remove('hidden');
  el('recipeNameInput')?.focus();
}

function setupRecipeFormModal() {
  const modal = getRecipeFormModal();
  if (!modal || modal.dataset.bound) return;
  modal.dataset.bound = '1';

  el('recipeFormClose')?.addEventListener('click', closeRecipeFormModal);
  el('recipeFormCancel')?.addEventListener('click', closeRecipeFormModal);
  el('addIngredientRowBtn')?.addEventListener('click', addRecipeIngredientRow);

  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeRecipeFormModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeRecipeFormModal();
  });

  el('recipeForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitBtn = el('recipeFormSubmit');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const payload = getRecipeFormPayload();
      if (modal.dataset.mode === 'edit' && modal.dataset.recipeId) {
        await api(`/api/recipes/${modal.dataset.recipeId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        showToast('Recipe updated', 'success');
      } else {
        await api('/api/recipes', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        showToast('Recipe created', 'success');
      }
      closeRecipeFormModal();
      await refreshActiveTab();
    } catch (err) {
      showToast(err.message || 'Unable to save recipe', 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

function getAppFormModal() {
  return el('appFormModal');
}

function closeAppFormModal() {
  const modal = getAppFormModal();
  if (!modal) return;
  modal.classList.add('hidden');
  state.appFormSubmit = null;
  el('appFormFields').innerHTML = '';
  el('appForm')?.reset();
}

function renderAppFormField(field, value = '') {
  const fieldId = `app-field-${field.name}`;
  const common = [
    `id="${fieldId}"`,
    `name="${field.name}"`,
    field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '',
    field.required ? 'required' : '',
    field.min !== undefined ? `min="${field.min}"` : '',
    field.max !== undefined ? `max="${field.max}"` : '',
    field.step !== undefined ? `step="${field.step}"` : '',
  ]
    .filter(Boolean)
    .join(' ');

  let control = '';
  if (field.type === 'select') {
    const emptyOption = field.emptyLabel !== undefined ? `<option value="">${escapeHtml(field.emptyLabel)}</option>` : '';
    const options = (field.options || [])
      .map((option) => {
        const selected = String(option.value) === String(value) ? 'selected' : '';
        return `<option value="${escapeHtml(option.value)}" ${selected}>${escapeHtml(option.label)}</option>`;
      })
      .join('');
    control = `<select ${common}>${emptyOption}${options}</select>`;
  } else if (field.type === 'textarea') {
    control = `<textarea ${common} rows="${field.rows || 6}">${escapeHtml(value)}</textarea>`;
  } else {
    const inputType = field.type || 'text';
    control = `<input type="${inputType}" value="${escapeHtml(value)}" ${common} />`;
  }

  return `
    <div class="app-form-field ${field.fullWidth ? 'full' : ''}">
      <label for="${fieldId}">${escapeHtml(field.label)}</label>
      ${control}
      ${field.hint ? `<p class="form-hint">${escapeHtml(field.hint)}</p>` : ''}
    </div>
  `;
}

function readAppFormValues(fields) {
  const form = el('appForm');
  const values = {};
  for (const field of fields) {
    const input = form?.elements.namedItem(field.name);
    values[field.name] = input ? input.value : '';
  }
  return values;
}

function openAppFormModal(config) {
  const modal = getAppFormModal();
  if (!modal) return;

  el('appFormEyebrow').textContent = config.eyebrow || 'Workspace';
  el('appFormTitle').textContent = config.title || 'Create';
  el('appFormSubtitle').textContent = config.subtitle || '';
  el('appFormSubmit').textContent = config.submitLabel || 'Save';
  el('appFormFields').innerHTML = (config.fields || [])
    .map((field) => renderAppFormField(field, config.initialValues?.[field.name] ?? field.value ?? ''))
    .join('');

  state.appFormSubmit = config.onSubmit;
  modal.classList.remove('hidden');
  const firstInput = el('appForm')?.querySelector('input, select, textarea');
  firstInput?.focus();
}

function setupAppFormModal() {
  const modal = getAppFormModal();
  if (!modal || modal.dataset.bound) return;
  modal.dataset.bound = '1';

  el('appFormClose')?.addEventListener('click', closeAppFormModal);
  el('appFormCancel')?.addEventListener('click', closeAppFormModal);

  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeAppFormModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeAppFormModal();
  });

  el('appForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitBtn = el('appFormSubmit');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const fields = state.appFormSubmit?.fields || [];
      const values = readAppFormValues(fields);
      if (typeof state.appFormSubmit?.handler === 'function') {
        await state.appFormSubmit.handler(values);
      }
      closeAppFormModal();
    } catch (err) {
      showToast(err.message || 'Unable to save changes', 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

function setTabs() {
  const tabs = state.tabs.filter((t) => !(t === 'users' && state.user?.role !== 'admin'));
  const desktopNavHtml = tabs
    .map((t) => {
      const meta = tabMeta[t] || { label: t, shortLabel: t };
      return `<button class="tab-btn ${state.activeTab === t ? 'active' : ''}" onclick="switchTab('${t}')" aria-label="${meta.label}">
        <span class="tab-copy">
          <span class="tab-label">${meta.label}</span>
        </span>
      </button>`;
    })
    .join('');
  const mobileNavHtml = tabs
    .map((t) => {
      const meta = tabMeta[t] || { label: t, shortLabel: t };
      return `<button class="tab-btn ${state.activeTab === t ? 'active' : ''}" onclick="switchTab('${t}')" aria-label="${meta.label}">
        <span class="tab-label">${meta.shortLabel}</span>
      </button>`;
    })
    .join('');
  el('tabs').innerHTML = desktopNavHtml;
  if (el('mobileTabs')) el('mobileTabs').innerHTML = mobileNavHtml;
}

function switchTab(tab) {
  state.activeTab = tab;
  for (const pane of document.querySelectorAll('.tab-pane')) pane.classList.add('hidden');
  el(tab).classList.remove('hidden');
  setTabs();
  closeMobileSidebar();
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
    setupShellInteractions();
    switchTab('dashboard');
  } catch (err) {
    showToast(`Login failed: ${err.message}`, 'error');
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
    setupShellInteractions();
    switchTab('dashboard');
  } catch (_err) {
    logout();
  }
}

async function refreshActiveTab() {
  if (!state.user) return;
  renderLoadingState(state.activeTab);
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
    const activePane = el(state.activeTab);
    if (activePane) {
      enhanceResponsiveTables(activePane);
      const actionRow = activePane.querySelector('.row.between .row.gap');
      if (actionRow) actionRow.classList.add('mobile-sticky-actions');
    }
  } catch (err) {
    renderErrorState(state.activeTab, err.message);
    showToast(err.message, 'error');
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
  openAppFormModal({
    eyebrow: 'Quick Action',
    title: listType === 'additional' ? 'Add Additional Prep Task' : 'Add Daily Prep Task',
    subtitle: 'Capture a prep task without leaving the dashboard.',
    submitLabel: 'Add Task',
    fields: [
      { name: 'title', label: 'Task title', type: 'text', required: true, fullWidth: true, placeholder: 'Example: Portion chicken for dinner service' },
      {
        name: 'priority',
        label: 'Priority',
        type: 'select',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'med', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
      { name: 'due_time', label: 'Due time', type: 'time' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 4, fullWidth: true, placeholder: 'Optional handoff or prep notes' },
    ],
    initialValues: { priority: 'med' },
    onSubmit: {
      fields: [{ name: 'title' }, { name: 'priority' }, { name: 'due_time' }, { name: 'notes' }],
      handler: async (values) => {
        const title = (values.title || '').trim();
        if (!title) throw new Error('Task title is required');
        await api('/api/prep-tasks', {
          method: 'POST',
          body: JSON.stringify({
            title,
            list_type: listType,
            priority: values.priority || 'med',
            due_time: values.due_time || null,
            notes: values.notes || '',
            status: 'todo',
          }),
        });
        showToast('Task added', 'success');
        await refreshActiveTab();
      },
    },
  });
}

async function quickAddGrocery() {
  const lists = await api('/api/grocery-lists');
  let listId = lists[0]?.id;
  if (!listId) {
    const created = await api('/api/grocery-lists', { method: 'POST', body: JSON.stringify({}) });
    listId = created.id;
  }
  openAppFormModal({
    eyebrow: 'Quick Action',
    title: 'Add Grocery Item',
    subtitle: 'Create a grocery request from the dashboard with a proper form.',
    submitLabel: 'Add Item',
    fields: [
      { name: 'name', label: 'Item name', type: 'text', required: true, fullWidth: true, placeholder: 'Example: Roma tomatoes' },
      { name: 'quantity', label: 'Quantity', type: 'number', min: 0.01, step: 0.01, required: true },
      { name: 'unit', label: 'Unit', type: 'text', required: true, placeholder: 'kg' },
      { name: 'vendor', label: 'Vendor', type: 'text', fullWidth: true, placeholder: 'Optional supplier' },
    ],
    initialValues: { quantity: 1, unit: 'kg' },
    onSubmit: {
      fields: [{ name: 'name' }, { name: 'quantity' }, { name: 'unit' }, { name: 'vendor' }],
      handler: async (values) => {
        const quantity = Number(values.quantity || '0');
        if (!(quantity > 0)) throw new Error('Quantity must be greater than 0');
        await api(`/api/grocery-lists/${listId}/items`, {
          method: 'POST',
          body: JSON.stringify({
            name: (values.name || '').trim(),
            quantity,
            unit: (values.unit || 'kg').trim() || 'kg',
            vendor: (values.vendor || '').trim(),
          }),
        });
        showToast('Added to grocery list', 'success');
        await refreshActiveTab();
      },
    },
  });
}

async function quickAdjustInventory() {
  const items = await api('/api/inventory');
  openAppFormModal({
    eyebrow: 'Quick Action',
    title: 'Adjust Inventory',
    subtitle: 'Pick an item and log the quantity change without browser dialogs.',
    submitLabel: 'Save Adjustment',
    fields: [
      {
        name: 'inventory_item_id',
        label: 'Inventory item',
        type: 'select',
        required: true,
        fullWidth: true,
        emptyLabel: 'Choose an item',
        options: items.map((item) => ({
          value: item.id,
          label: `${item.name} (${fmtNum(item.current_quantity)} ${item.base_unit})`,
        })),
      },
      { name: 'change_quantity', label: 'Change quantity', type: 'number', step: 0.01, required: true, hint: 'Use negative values for waste or shrinkage.' },
      {
        name: 'reason',
        label: 'Reason',
        type: 'select',
        options: [
          { value: 'adjustment', label: 'Adjustment' },
          { value: 'waste', label: 'Waste' },
          { value: 'received', label: 'Received' },
          { value: 'counted', label: 'Counted' },
          { value: 'transferred', label: 'Transferred' },
        ],
      },
    ],
    initialValues: { change_quantity: -1, reason: 'adjustment' },
    onSubmit: {
      fields: [{ name: 'inventory_item_id' }, { name: 'change_quantity' }, { name: 'reason' }],
      handler: async (values) => {
        const id = Number(values.inventory_item_id || '0');
        const change = Number(values.change_quantity || '0');
        if (!id) throw new Error('Select an inventory item');
        if (!Number.isFinite(change) || change === 0) throw new Error('Change quantity cannot be 0');
        await api(`/api/inventory/${id}/adjust`, {
          method: 'POST',
          body: JSON.stringify({ change_quantity: change, reason: values.reason || 'adjustment', source: 'quick_action' }),
        });
        showToast('Inventory adjusted', 'success');
        await refreshActiveTab();
      },
    },
  });
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
      <div class="filter-panel">
        <button class="btn secondary" onclick="toggleFilterPanel('recipesFilterPanel')">Filters</button>
        <div id="recipesFilterPanel" class="filter-body hidden">
          <label for="recipeFilterInput">Find recipes</label>
          <input id="recipeFilterInput" placeholder="Search name or category" oninput="filterTableRows('recipesTable', this.value)" />
        </div>
      </div>
      ${!roleCanEdit() ? '<p><small>Prep role is read-only for recipes. Use Admin/Manager account to create/edit.</small></p>' : ''}
      <div class="table-wrap">
        <table id="recipesTable">
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
    openRecipeFormModal({
      mode: 'create',
      inventory,
      recipe: {
        name: '',
        category: 'prep',
        yield_amount: 1,
        yield_unit: 'kg',
        portion_size: '',
        instructions: '',
        ingredients: [],
      },
    });
  };

  window.editRecipe = async function (id) {
    const r = await api(`/api/recipes/${id}`);
    openRecipeFormModal({ mode: 'edit', recipe: r, inventory });
  };

  window.deleteRecipe = async function (id) {
    if (!confirm('Delete this recipe?')) return;
    await api(`/api/recipes/${id}`, { method: 'DELETE' });
    showToast('Recipe deleted', 'success');
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
    openAppFormModal({
      eyebrow: 'Recipes',
      title: 'Scale Recipe',
      subtitle: 'Enter the target yield and review the scaled ingredient list below.',
      submitLabel: 'Scale Recipe',
      fields: [{ name: 'target_yield', label: 'Target yield amount', type: 'number', min: 0.01, step: 0.01, required: true }],
      initialValues: { target_yield: 1 },
      onSubmit: {
        fields: [{ name: 'target_yield' }],
        handler: async (values) => {
          const target = Number(values.target_yield || '0');
          if (!(target > 0)) throw new Error('Target yield amount must be greater than 0');
          const scaled = await api(`/api/recipes/${id}/scale?target_yield=${target}`);
          el('recipeDetails').innerHTML = `
            <div class="card mt">
              <h4>${escapeHtml(scaled.recipe_name)} scaled to ${fmtNum(scaled.target_yield)} ${escapeHtml(scaled.yield_unit)}</h4>
              <ul>
                ${scaled.scaled_ingredients.map((x) => `<li>${escapeHtml(x.ingredient)}: ${fmtNum(x.quantity)} ${escapeHtml(x.unit)}</li>`).join('')}
              </ul>
            </div>
          `;
        },
      },
    });
  };

  window.exportRecipe = async function (id) {
    const txt = await api(`/api/recipes/${id}/export`);
    el('recipeDetails').innerHTML = `
      <div class="card mt">
        <h4>Recipe Export</h4>
        <pre>${escapeHtml(txt)}</pre>
      </div>
    `;
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
      showToast(`Imported ${res.imported_recipes} recipes`, 'success');
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
        <div class="filter-panel">
          <button class="btn secondary" onclick="toggleFilterPanel('inventoryFilterPanel')">Filters</button>
          <div id="inventoryFilterPanel" class="filter-body hidden">
            <label for="inventoryFilterInput">Find inventory</label>
            <input id="inventoryFilterInput" placeholder="Search item, category, supplier" oninput="filterTableRows('inventoryTable', this.value)" />
          </div>
        </div>
        <div class="table-wrap">
          <table id="inventoryTable">
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
    const item = items.find((row) => row.id === id);
    openAppFormModal({
      eyebrow: 'Inventory',
      title: `Adjust ${item?.name || 'Item'}`,
      subtitle: 'Log the quantity update with a cleaner adjustment form.',
      submitLabel: 'Save Adjustment',
      fields: [
        { name: 'change_quantity', label: 'Change quantity', type: 'number', step: 0.01, required: true },
        {
          name: 'reason',
          label: 'Reason',
          type: 'select',
          options: [
            { value: 'adjustment', label: 'Adjustment' },
            { value: 'waste', label: 'Waste' },
            { value: 'received', label: 'Received' },
            { value: 'counted', label: 'Counted' },
            { value: 'transferred', label: 'Transferred' },
          ],
        },
      ],
      initialValues: { change_quantity: -1, reason: 'adjustment' },
      onSubmit: {
        fields: [{ name: 'change_quantity' }, { name: 'reason' }],
        handler: async (values) => {
          const change = Number(values.change_quantity || '0');
          if (!Number.isFinite(change) || change === 0) throw new Error('Change quantity cannot be 0');
          await api(`/api/inventory/${id}/adjust`, {
            method: 'POST',
            body: JSON.stringify({ change_quantity: change, reason: values.reason || 'adjustment', source: 'inventory_tab' }),
          });
          showToast('Inventory adjusted', 'success');
          await refreshActiveTab();
        },
      },
    });
  };

  window.createInventoryItem = async function () {
    openAppFormModal({
      eyebrow: 'Inventory',
      title: 'Add Inventory Item',
      subtitle: 'Capture stock, par levels, and supplier details in one form.',
      submitLabel: 'Create Item',
      fields: [
        { name: 'name', label: 'Item name', type: 'text', required: true, fullWidth: true, placeholder: 'Example: Baby spinach' },
        { name: 'category', label: 'Category', type: 'text', required: true, placeholder: 'Produce' },
        { name: 'base_unit', label: 'Base unit', type: 'text', required: true, placeholder: 'kg' },
        { name: 'current_quantity', label: 'Current quantity', type: 'number', step: 0.01, required: true },
        { name: 'par_level', label: 'Par level', type: 'number', step: 0.01, required: true },
        { name: 'reorder_threshold', label: 'Reorder threshold', type: 'number', step: 0.01, required: true },
        { name: 'cost_per_unit', label: 'Cost per unit', type: 'number', step: 0.01, required: true },
        { name: 'supplier', label: 'Supplier', type: 'text', fullWidth: true, placeholder: 'Optional supplier or vendor' },
      ],
      initialValues: { category: 'Produce', base_unit: 'kg', current_quantity: 0, par_level: 0, reorder_threshold: 0, cost_per_unit: 0 },
      onSubmit: {
        fields: [{ name: 'name' }, { name: 'category' }, { name: 'base_unit' }, { name: 'current_quantity' }, { name: 'par_level' }, { name: 'reorder_threshold' }, { name: 'cost_per_unit' }, { name: 'supplier' }],
        handler: async (values) => {
          await api('/api/inventory', {
            method: 'POST',
            body: JSON.stringify({
              name: (values.name || '').trim(),
              category: (values.category || 'Produce').trim() || 'Produce',
              base_unit: (values.base_unit || 'kg').trim() || 'kg',
              current_quantity: Number(values.current_quantity || '0'),
              par_level: Number(values.par_level || '0'),
              reorder_threshold: Number(values.reorder_threshold || '0'),
              cost_per_unit: Number(values.cost_per_unit || '0'),
              supplier: (values.supplier || '').trim(),
            }),
          });
          showToast('Inventory item created', 'success');
          await refreshActiveTab();
        },
      },
    });
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
      showToast(`Imported ${res.imported_items} inventory items`, 'success');
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
            <thead><tr><th>Recipe</th><th>Target Yield</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              ${
                planData.items
                  .map(
                    (x) => `<tr class="${x.status === 'done' ? 'done-row' : ''}">
                      <td><b class="${x.status === 'done' ? 'done-text' : ''}">${x.status === 'done' ? '✓ ' : ''}${x.recipe_name}</b></td>
                      <td>${fmtNum(x.target_yield_amount)} ${x.yield_unit}</td>
                      <td>${x.status || 'planned'}</td>
                      <td>
                        ${
                          x.status === 'done'
                            ? `<button class="btn danger" onclick="removeProductionItem(${x.id})">Remove</button>`
                            : `<button class="btn" onclick="markProductionDone(${x.id})">Done</button>`
                        }
                      </td>
                    </tr>`
                  )
                  .join('') || '<tr><td colspan="4">No items</td></tr>'
              }
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
    openAppFormModal({
      eyebrow: 'Production',
      title: 'Add Production Item',
      subtitle: 'Select a recipe and define the target output for today’s run.',
      submitLabel: 'Add Production',
      fields: [
        {
          name: 'recipe_id',
          label: 'Recipe',
          type: 'select',
          required: true,
          fullWidth: true,
          emptyLabel: 'Choose a recipe',
          options: recipes.map((recipe) => ({
            value: recipe.id,
            label: `${recipe.name} (${fmtNum(recipe.yield_amount)} ${recipe.yield_unit})`,
          })),
        },
        { name: 'target_yield_amount', label: 'Target yield amount', type: 'number', min: 0.01, step: 0.01, required: true },
      ],
      initialValues: { target_yield_amount: 1 },
      onSubmit: {
        fields: [{ name: 'recipe_id' }, { name: 'target_yield_amount' }],
        handler: async (values) => {
          const recipe_id = Number(values.recipe_id || '0');
          const target_yield_amount = Number(values.target_yield_amount || '0');
          if (!recipe_id) throw new Error('Select a recipe');
          if (!(target_yield_amount > 0)) throw new Error('Target yield amount must be greater than 0');
          await api(`/api/production-plans/${plan.id}/items`, {
            method: 'POST',
            body: JSON.stringify({ recipe_id, target_yield_amount }),
          });
          showToast('Production item added', 'success');
          await refreshActiveTab();
        },
      },
    });
  };

  window.sendShortages = async function () {
    if (!plan) return;
    const res = await api(`/api/production-plans/${plan.id}/send-shortages`, { method: 'POST', body: '{}' });
    showToast(`Added ${res.added} shortages to grocery list #${res.grocery_list_id || '-'}`, 'success');
    await refreshActiveTab();
  };

  window.markProductionDone = async function (itemId) {
    await api(`/api/production-plan-items/${itemId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    });
    showToast('Production marked done and inventory deducted', 'success');
    await refreshActiveTab();
  };

  window.removeProductionItem = async function (itemId) {
    if (!confirm('Remove this production item from the list?')) return;
    await api(`/api/production-plan-items/${itemId}`, { method: 'DELETE' });
    showToast('Production item removed', 'success');
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
    openAppFormModal({
      eyebrow: 'Grocery',
      title: 'Add Grocery Item',
      subtitle: 'Create a manual grocery line item without browser prompts.',
      submitLabel: 'Add Item',
      fields: [
        { name: 'name', label: 'Item name', type: 'text', required: true, fullWidth: true, placeholder: 'Example: Olive oil' },
        { name: 'quantity', label: 'Quantity', type: 'number', min: 0.01, step: 0.01, required: true },
        { name: 'unit', label: 'Unit', type: 'text', required: true, placeholder: 'kg' },
        { name: 'vendor', label: 'Vendor', type: 'text', fullWidth: true, placeholder: 'Optional supplier' },
      ],
      initialValues: { quantity: 1, unit: 'kg' },
      onSubmit: {
        fields: [{ name: 'name' }, { name: 'quantity' }, { name: 'unit' }, { name: 'vendor' }],
        handler: async (values) => {
          const quantity = Number(values.quantity || '0');
          if (!(quantity > 0)) throw new Error('Quantity must be greater than 0');
          await api(`/api/grocery-lists/${list.id}/items`, {
            method: 'POST',
            body: JSON.stringify({
              name: (values.name || '').trim(),
              quantity,
              unit: (values.unit || 'kg').trim() || 'kg',
              vendor: (values.vendor || '').trim(),
            }),
          });
          showToast('Grocery item added', 'success');
          await refreshActiveTab();
        },
      },
    });
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
    openAppFormModal({
      eyebrow: 'Prep',
      title: 'Add Prep Task',
      subtitle: 'Create a prep task with assignment, linked recipe, and timing details in one place.',
      submitLabel: 'Add Task',
      fields: [
        { name: 'title', label: 'Task title', type: 'text', required: true, fullWidth: true, placeholder: 'Example: Marinate chicken thighs' },
        {
          name: 'list_type',
          label: 'List type',
          type: 'select',
          options: [
            { value: 'daily', label: 'Prep List for the Day' },
            { value: 'additional', label: 'Additional Prep List' },
          ],
        },
        {
          name: 'priority',
          label: 'Priority',
          type: 'select',
          options: [
            { value: 'low', label: 'Low' },
            { value: 'med', label: 'Medium' },
            { value: 'high', label: 'High' },
          ],
        },
        {
          name: 'recipe_id',
          label: 'Linked recipe',
          type: 'select',
          emptyLabel: 'No linked recipe',
          options: recipes.map((recipe) => ({ value: recipe.id, label: recipe.name })),
        },
        {
          name: 'assigned_to',
          label: 'Assign to',
          type: 'select',
          emptyLabel: 'Unassigned',
          options: users.map((user) => ({ value: user.id, label: `${user.full_name} (${user.role})` })),
        },
        { name: 'due_time', label: 'Due time', type: 'time' },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 5, fullWidth: true, placeholder: 'Station notes, allergen warnings, handoff info...' },
      ],
      initialValues: { list_type: 'daily', priority: 'med' },
      onSubmit: {
        fields: [{ name: 'title' }, { name: 'list_type' }, { name: 'priority' }, { name: 'recipe_id' }, { name: 'assigned_to' }, { name: 'due_time' }, { name: 'notes' }],
        handler: async (values) => {
          const title = (values.title || '').trim();
          if (!title) throw new Error('Task title is required');
          await api('/api/prep-tasks', {
            method: 'POST',
            body: JSON.stringify({
              title,
              list_type: values.list_type === 'additional' ? 'additional' : 'daily',
              priority: values.priority || 'med',
              recipe_id: Number(values.recipe_id || '0') || null,
              assigned_to: Number(values.assigned_to || '0') || null,
              due_time: values.due_time || null,
              notes: values.notes || '',
            }),
          });
          showToast('Task added', 'success');
          await refreshActiveTab();
        },
      },
    });
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
    openAppFormModal({
      eyebrow: 'Schedule',
      title: 'Add Shift',
      subtitle: 'Schedule a team member without relying on a stack of browser dialogs.',
      submitLabel: 'Create Shift',
      fields: [
        {
          name: 'user_id',
          label: 'Team member',
          type: 'select',
          required: true,
          emptyLabel: 'Choose a team member',
          options: users.map((user) => ({ value: user.id, label: `${user.full_name} (${user.role})` })),
        },
        { name: 'shift_date', label: 'Shift date', type: 'date', required: true },
        { name: 'start_time', label: 'Start time', type: 'time', required: true },
        { name: 'end_time', label: 'End time', type: 'time', required: true },
        { name: 'station', label: 'Station', type: 'text', placeholder: 'Prep' },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 5, fullWidth: true, placeholder: 'Coverage details, special requests, break notes...' },
      ],
      initialValues: {
        shift_date: new Date().toISOString().slice(0, 10),
        start_time: '09:00',
        end_time: '17:00',
        station: 'Prep',
      },
      onSubmit: {
        fields: [{ name: 'user_id' }, { name: 'shift_date' }, { name: 'start_time' }, { name: 'end_time' }, { name: 'station' }, { name: 'notes' }],
        handler: async (values) => {
          const user_id = Number(values.user_id || '0');
          if (!user_id) throw new Error('Choose a team member');
          await api('/api/schedules', {
            method: 'POST',
            body: JSON.stringify({
              user_id,
              shift_date: values.shift_date,
              start_time: values.start_time,
              end_time: values.end_time,
              station: values.station || '',
              notes: values.notes || '',
              status: 'scheduled',
            }),
          });
          showToast('Shift added', 'success');
          await refreshActiveTab();
        },
      },
    });
  };

  window.editSchedule = async function (id) {
    const row = schedules.find((s) => s.id === id);
    if (!row) return;
    openAppFormModal({
      eyebrow: 'Schedule',
      title: `Edit Shift for ${row.chef_name}`,
      subtitle: 'Update staffing details from a proper form instead of browser prompts.',
      submitLabel: 'Save Shift',
      fields: [
        {
          name: 'user_id',
          label: 'Team member',
          type: 'select',
          required: true,
          emptyLabel: 'Choose a team member',
          options: users.map((user) => ({ value: user.id, label: `${user.full_name} (${user.role})` })),
        },
        { name: 'shift_date', label: 'Shift date', type: 'date', required: true },
        { name: 'start_time', label: 'Start time', type: 'time', required: true },
        { name: 'end_time', label: 'End time', type: 'time', required: true },
        { name: 'station', label: 'Station', type: 'text' },
        {
          name: 'status',
          label: 'Status',
          type: 'select',
          options: [
            { value: 'scheduled', label: 'Scheduled' },
            { value: 'confirmed', label: 'Confirmed' },
            { value: 'cancelled', label: 'Cancelled' },
          ],
        },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 5, fullWidth: true },
      ],
      initialValues: {
        user_id: row.user_id,
        shift_date: row.shift_date,
        start_time: row.start_time,
        end_time: row.end_time,
        station: row.station || '',
        status: row.status,
        notes: row.notes || '',
      },
      onSubmit: {
        fields: [{ name: 'user_id' }, { name: 'shift_date' }, { name: 'start_time' }, { name: 'end_time' }, { name: 'station' }, { name: 'status' }, { name: 'notes' }],
        handler: async (values) => {
          const user_id = Number(values.user_id || '0');
          if (!user_id) throw new Error('Choose a team member');
          await api(`/api/schedules/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
              user_id,
              shift_date: values.shift_date,
              start_time: values.start_time,
              end_time: values.end_time,
              station: values.station || '',
              notes: values.notes || '',
              status: values.status || row.status,
            }),
          });
          showToast('Shift updated', 'success');
          await refreshActiveTab();
        },
      },
    });
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
    openAppFormModal({
      eyebrow: 'Users',
      title: 'Create User',
      subtitle: 'Add a new team account with role and password details in one cleaner form.',
      submitLabel: 'Create User',
      fields: [
        { name: 'username', label: 'Username', type: 'text', required: true },
        { name: 'full_name', label: 'Full name', type: 'text', required: true },
        {
          name: 'role',
          label: 'Role',
          type: 'select',
          options: [
            { value: 'admin', label: 'Admin' },
            { value: 'manager', label: 'Manager' },
            { value: 'prep', label: 'Prep' },
          ],
        },
        { name: 'password', label: 'Password', type: 'password', required: true },
      ],
      initialValues: { role: 'prep', password: 'admin123' },
      onSubmit: {
        fields: [{ name: 'username' }, { name: 'full_name' }, { name: 'role' }, { name: 'password' }],
        handler: async (values) => {
          const username = (values.username || '').trim();
          if (!username) throw new Error('Username is required');
          await api('/api/users', {
            method: 'POST',
            body: JSON.stringify({
              username,
              full_name: (values.full_name || username).trim(),
              role: values.role || 'prep',
              password: values.password || 'admin123',
            }),
          });
          showToast('User created', 'success');
          await refreshActiveTab();
        },
      },
    });
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

setupRecipeFormModal();
setupAppFormModal();
bootSession();
