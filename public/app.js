const state = {
  user: null,
  store: null,
  needsSetup: false,
  currentView: 'dashboard',
  customers: [],
  products: [],
  withdrawalFilters: {
    customer_id: '',
    status: '',
    start_date: '',
    end_date: '',
    work_reference: '',
    q: '',
  },
  cart: [],
  withdrawalIdempotencyKey: null,
  closingIdempotencyKey: null,
};

// Helpers
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Erro HTTP ${res.status}`);
  }
  return data;
}

function formatCents(cents) {
  return (Number(cents || 0) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function formatQty(q) {
  const num = Number(q || 0);
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: num % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 3,
  });
}

function formatDateTime(str) {
  if (!str) return '';
  const clean = str.replace('T', ' ');
  const [d, t] = clean.split(' ');
  const parts = (d || '').split('-');
  if (parts.length !== 3) return str;
  return `${parts[2]}/${parts[1]}/${parts[0]}${t ? ' ' + t.slice(0, 5) : ''}`;
}

function formatDate(str) {
  if (!str) return '';
  const d = str.replace('T', ' ').split(' ')[0];
  const parts = d.split('-');
  if (parts.length !== 3) return str;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function nowInputDateTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function genKey() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toast(msg, isError = false) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function openModal(title, htmlContent) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = htmlContent;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-body').innerHTML = '';
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') closeModal();
});

// Auth & Init
async function checkAuth() {
  const data = await api('/api/auth/me');
  state.needsSetup = data.needsSetup;
  state.user = data.user;
  state.store = data.store;

  const authScreen = document.getElementById('auth-screen');
  const appShell = document.getElementById('app-shell');

  if (!state.user) {
    appShell.classList.add('hidden');
    authScreen.classList.remove('hidden');
    const setupGroup = document.getElementById('setup-name-group');
    const title = document.getElementById('auth-title');
    const sub = document.getElementById('auth-subtitle');
    const btn = document.getElementById('auth-submit-btn');

    if (state.needsSetup) {
      setupGroup.classList.remove('hidden');
      title.textContent = 'Configuração Inicial';
      sub.textContent = 'Crie o primeiro usuário Administrador para iniciar o sistema';
      btn.textContent = 'Criar Administrador e Entrar';
    } else {
      setupGroup.classList.add('hidden');
      title.textContent = 'Acesso ao Sistema';
      sub.textContent = 'Controle de Retiradas e Contas em Aberto';
      btn.textContent = 'Entrar';
    }
    return;
  }

  authScreen.classList.add('hidden');
  appShell.classList.remove('hidden');

  const roleLabels = { admin: 'Administrador', gerente: 'Gerente', atendente: 'Atendente' };
  document.getElementById('sidebar-user-name').textContent = state.user.name;
  document.getElementById('sidebar-user-role').textContent = roleLabels[state.user.role] || state.user.role;
  document.getElementById('mobile-user-badge').textContent = roleLabels[state.user.role] || state.user.role;

  // Filter nav items by role
  document.querySelectorAll('.nav-item[data-roles]').forEach((btn) => {
    const allowed = btn.dataset.roles.split(',');
    btn.classList.toggle('hidden', !allowed.includes(state.user.role));
  });

  await navigate('dashboard');
}

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('auth-error');
  errEl.classList.add('hidden');
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const name = document.getElementById('auth-name').value.trim();

  try {
    if (state.needsSetup) {
      await api('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ name, username, password }),
      });
      toast('Administrador criado com sucesso!');
    } else {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
    }
    document.getElementById('auth-password').value = '';
    await checkAuth();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  await checkAuth();
});

// Mobile Sidebar Toggle
const sidebar = document.getElementById('sidebar');
const backdrop = document.getElementById('sidebar-backdrop');
function closeSidebar() {
  sidebar.classList.remove('open');
  backdrop.classList.add('hidden');
}
document.getElementById('menu-toggle').addEventListener('click', () => {
  sidebar.classList.toggle('open');
  backdrop.classList.toggle('hidden');
});
backdrop.addEventListener('click', closeSidebar);

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', async () => {
    closeSidebar();
    await navigate(btn.dataset.view);
  });
});

async function navigate(view) {
  state.currentView = view;
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });

  const container = document.getElementById('view-container');
  container.innerHTML = '<div class="card">Carregando...</div>';

  try {
    if (view === 'dashboard') await renderDashboard(container);
    else if (view === 'new-withdrawal') await renderNewWithdrawal(container);
    else if (view === 'withdrawals') await renderWithdrawals(container);
    else if (view === 'closing') await renderClosingAndOrders(container, false);
    else if (view === 'orders-only') await renderClosingAndOrders(container, true);
    else if (view === 'customers') await renderCustomers(container);
    else if (view === 'products') await renderProducts(container);
    else if (view === 'reports') await renderReports(container);
    else if (view === 'admin') await renderAdmin(container);
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

// 1. DASHBOARD
async function renderDashboard(container) {
  const data = await api('/api/reports/dashboard');
  const { kpis, pending_customers, recent_withdrawals } = data;
  const canClose = ['admin', 'gerente'].includes(state.user.role);

  container.innerHTML = `
    <div class="page-header">
      <h1>Painel Inicial</h1>
      <div class="btn-group">
        <button class="btn btn-primary btn-lg" id="dash-new-w">➕ Nova Retirada</button>
        ${canClose ? '<button class="btn btn-dark btn-lg" id="dash-close">🧾 Fechar Conta / Pedido</button>' : ''}
      </div>
    </div>

    <div class="grid-4">
      <div class="kpi-card">
        <div class="kpi-label">Total em Aberto</div>
        <div class="kpi-value">${formatCents(kpis.open_total_cents)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Clientes Pendentes</div>
        <div class="kpi-value">${kpis.pending_customers_count}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Retiradas do Dia</div>
        <div class="kpi-value">${kpis.today_withdrawals_count}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Pedidos no Mês</div>
        <div class="kpi-value">${kpis.month_orders_count}</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2 class="card-title">Clientes com Retiradas Pendentes</h2>
        ${
          pending_customers.length === 0
            ? '<p class="muted">Nenhum cliente com conta em aberto no momento.</p>'
            : `<div class="table-wrap"><table>
                <thead><tr><th>Cliente</th><th class="text-center">Retiradas</th><th class="text-right">Saldo Aberto</th><th></th></tr></thead>
                <tbody>
                  ${pending_customers
                    .map(
                      (c) => `<tr>
                        <td><strong>${escapeHtml(c.customer_name)}</strong><br><span class="muted">${escapeHtml(c.customer_phone || '')}</span></td>
                        <td class="text-center">${c.open_count}</td>
                        <td class="text-right"><strong>${formatCents(c.open_total_cents)}</strong></td>
                        <td class="text-right"><button class="btn btn-outline btn-sm open-cust-btn" data-id="${c.customer_id}">Ver Conta</button></td>
                      </tr>`
                    )
                    .join('')}
                </tbody>
              </table></div>`
        }
      </div>

      <div class="card">
        <h2 class="card-title">Últimas Retiradas</h2>
        ${
          recent_withdrawals.length === 0
            ? '<p class="muted">Nenhuma retirada registrada ainda.</p>'
            : `<div class="table-wrap"><table>
                <thead><tr><th>Código</th><th>Cliente</th><th>Data</th><th>Status</th><th class="text-right">Total</th></tr></thead>
                <tbody>
                  ${recent_withdrawals
                    .map(
                      (w) => `<tr>
                        <td><strong>${escapeHtml(w.code)}</strong></td>
                        <td>${escapeHtml(w.customer_name)}</td>
                        <td>${formatDateTime(w.withdrawal_date)}</td>
                        <td><span class="badge badge-${w.status}">${w.status}</span></td>
                        <td class="text-right">${formatCents(w.net_total_cents)}</td>
                      </tr>`
                    )
                    .join('')}
                </tbody>
              </table></div>`
        }
      </div>
    </div>
  `;

  document.getElementById('dash-new-w').addEventListener('click', () => navigate('new-withdrawal'));
  const closeBtn = document.getElementById('dash-close');
  if (closeBtn) closeBtn.addEventListener('click', () => navigate('closing'));

  container.querySelectorAll('.open-cust-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.withdrawalFilters.customer_id = btn.dataset.id;
      state.withdrawalFilters.status = 'aberta';
      navigate('withdrawals');
    });
  });
}

// 2. NOVA RETIRADA
async function renderNewWithdrawal(container) {
  const [customers, products] = await Promise.all([
    api('/api/customers?status=ativo'),
    api('/api/products?status=ativo'),
  ]);
  state.customers = customers;
  state.products = products;
  state.cart = [];
  state.withdrawalIdempotencyKey = genKey();

  const canDiscount = ['admin', 'gerente'].includes(state.user.role);

  container.innerHTML = `
    <div class="page-header">
      <h1>Registrar Nova Retirada</h1>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2 class="card-title">1. Dados da Retirada</h2>
        <div class="form-stack">
          <div>
            <label for="nw-customer">Cliente *</label>
            <select id="nw-customer">
              <option value="">-- Selecione o cliente --</option>
              ${customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.document ? ` (${escapeHtml(c.document)})` : ''}</option>`).join('')}
            </select>
          </div>
          <div class="grid-2">
            <div>
              <label for="nw-date">Data e Hora *</label>
              <input type="datetime-local" id="nw-date" value="${nowInputDateTime()}" />
            </div>
            <div>
              <label for="nw-work">Obra ou Referência</label>
              <input type="text" id="nw-work" placeholder="Ex: Obra Rua A, Casa 12" />
            </div>
          </div>
          <div>
            <label for="nw-auth-select">Pessoa Autorizada (cadastrada)</label>
            <select id="nw-auth-select">
              <option value="">-- Selecione ou digite abaixo --</option>
            </select>
          </div>
          <div>
            <label for="nw-picked-by">Nome de quem retirou *</label>
            <input type="text" id="nw-picked-by" placeholder="Ex: O próprio cliente ou portador" />
          </div>
          <div>
            <label for="nw-notes">Observações</label>
            <textarea id="nw-notes" rows="2" placeholder="Observações opcionais..."></textarea>
          </div>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">2. Buscar e Adicionar Produtos</h2>
        <div class="form-stack">
          <div>
            <label for="nw-prod-search">Buscar por Código, Descrição ou Código de Barras</label>
            <input type="text" id="nw-prod-search" placeholder="Digite código, barras ou nome do produto..." autocomplete="off" />
            <div id="nw-prod-results" class="search-results hidden"></div>
          </div>
        </div>

        <hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />
        <h3 style="margin:0 0 8px;font-size:1rem">Itens da Retirada</h3>
        <div id="nw-cart-container"></div>

        <div style="margin-top:14px;padding-top:12px;border-top:2px solid var(--border)">
          <div class="grid-2" style="align-items:end">
            <div>
              <label for="nw-discount">Desconto (R$) ${canDiscount ? '' : '(Apenas Gerente/Admin)'}</label>
              <input type="text" id="nw-discount" value="0,00" ${canDiscount ? '' : 'disabled'} />
            </div>
            <div class="text-right">
              <div class="muted">Total da Retirada</div>
              <div id="nw-total-display" style="font-size:1.7rem;font-weight:800;color:var(--brand-dark)">R$ 0,00</div>
            </div>
          </div>
          <button id="nw-save-btn" class="btn btn-primary btn-lg" style="width:100%;margin-top:14px">
            ✅ Salvar Retirada na Conta Aberta
          </button>
        </div>
      </div>
    </div>
  `;

  const custSelect = document.getElementById('nw-customer');
  const authSelect = document.getElementById('nw-auth-select');
  const pickedInput = document.getElementById('nw-picked-by');

  custSelect.addEventListener('change', () => {
    const cust = state.customers.find((c) => c.id === Number(custSelect.value));
    authSelect.innerHTML = '<option value="">-- Selecione ou digite abaixo --</option>';
    if (cust) {
      const optSelf = document.createElement('option');
      optSelf.value = `self:${cust.name}`;
      optSelf.textContent = `${cust.name} (Próprio cliente)`;
      authSelect.appendChild(optSelf);
      for (const p of cust.authorized_people || []) {
        const opt = document.createElement('option');
        opt.value = String(p.id);
        opt.dataset.name = p.name;
        opt.textContent = `${p.name}${p.identification ? ` (${p.identification})` : ''}`;
        authSelect.appendChild(opt);
      }
    }
  });

  authSelect.addEventListener('change', () => {
    const val = authSelect.value;
    if (val.startsWith('self:')) {
      pickedInput.value = val.slice(5);
    } else if (val) {
      const opt = authSelect.selectedOptions[0];
      pickedInput.value = opt.dataset.name || '';
    }
  });

  const searchInput = document.getElementById('nw-prod-search');
  const resultsBox = document.getElementById('nw-prod-results');

  function renderSearchResults(term) {
    const q = term.trim().toLowerCase();
    if (!q) {
      resultsBox.classList.add('hidden');
      return;
    }
    const matches = state.products
      .filter(
        (p) =>
          p.internal_code.toLowerCase().includes(q) ||
          (p.barcode || '').toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          (p.brand || '').toLowerCase().includes(q)
      )
      .slice(0, 15);

    if (matches.length === 0) {
      resultsBox.innerHTML = '<div class="search-result-item muted">Nenhum produto encontrado.</div>';
    } else {
      resultsBox.innerHTML = matches
        .map(
          (p) => `<div class="search-result-item" data-id="${p.id}">
            <div>
              <strong>${escapeHtml(p.internal_code)}</strong> — ${escapeHtml(p.description)}
              <div class="muted">${escapeHtml(p.brand || '')} • Unid: ${escapeHtml(p.unit)}</div>
            </div>
            <strong>${formatCents(p.price_cents)}</strong>
          </div>`
        )
        .join('');
    }
    resultsBox.classList.remove('hidden');

    resultsBox.querySelectorAll('.search-result-item[data-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const prod = state.products.find((p) => p.id === Number(el.dataset.id));
        if (prod) {
          state.cart.push({
            product_id: prod.id,
            code: prod.internal_code,
            description: prod.description,
            unit: prod.unit,
            quantity: 1,
            unit_price_cents: prod.price_cents,
          });
          searchInput.value = '';
          resultsBox.classList.add('hidden');
          renderCart();
        }
      });
    });
  }

  searchInput.addEventListener('input', () => renderSearchResults(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Exact barcode or code match
      const q = searchInput.value.trim().toLowerCase();
      const exact = state.products.find(
        (p) => (p.barcode && p.barcode.toLowerCase() === q) || p.internal_code.toLowerCase() === q
      );
      if (exact) {
        state.cart.push({
          product_id: exact.id,
          code: exact.internal_code,
          description: exact.description,
          unit: exact.unit,
          quantity: 1,
          unit_price_cents: exact.price_cents,
        });
        searchInput.value = '';
        resultsBox.classList.add('hidden');
        renderCart();
      }
    }
  });

  function parseBRCurrency(val) {
    const cleaned = String(val || '0').replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
    const num = Number(cleaned);
    return Number.isFinite(num) ? Math.max(0, Math.round(num * 100)) : 0;
  }

  function renderCart() {
    const cartEl = document.getElementById('nw-cart-container');
    if (state.cart.length === 0) {
      cartEl.innerHTML = '<p class="muted">Nenhum produto adicionado ainda.</p>';
      updateTotal();
      return;
    }

    cartEl.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Produto</th><th style="width:95px">Qtd</th><th style="width:110px">V. Unit (R$)</th><th class="text-right">Subtotal</th><th></th></tr></thead>
          <tbody>
            ${state.cart
              .map((item, idx) => {
                const sub = Math.round(item.quantity * item.unit_price_cents);
                return `<tr>
                  <td><strong>${escapeHtml(item.code)}</strong><br>${escapeHtml(item.description)} <span class="muted">(${escapeHtml(item.unit)})</span></td>
                  <td><input type="text" class="cart-qty" data-idx="${idx}" value="${String(item.quantity).replace('.', ',')}" /></td>
                  <td><input type="text" class="cart-price" data-idx="${idx}" value="${(item.unit_price_cents / 100).toFixed(2).replace('.', ',')}" /></td>
                  <td class="text-right"><strong>${formatCents(sub)}</strong></td>
                  <td><button class="btn btn-outline btn-sm cart-rem" data-idx="${idx}">✕</button></td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    cartEl.querySelectorAll('.cart-qty').forEach((inp) => {
      inp.addEventListener('change', () => {
        const idx = Number(inp.dataset.idx);
        const q = Number(inp.value.replace(',', '.'));
        if (Number.isFinite(q) && q > 0) {
          state.cart[idx].quantity = Math.round(q * 1000) / 1000;
        }
        renderCart();
      });
    });

    cartEl.querySelectorAll('.cart-price').forEach((inp) => {
      inp.addEventListener('change', () => {
        const idx = Number(inp.dataset.idx);
        state.cart[idx].unit_price_cents = parseBRCurrency(inp.value);
        renderCart();
      });
    });

    cartEl.querySelectorAll('.cart-rem').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.cart.splice(Number(btn.dataset.idx), 1);
        renderCart();
      });
    });

    updateTotal();
  }

  function updateTotal() {
    const subtotal = state.cart.reduce(
      (acc, it) => acc + Math.round(it.quantity * it.unit_price_cents),
      0
    );
    const disc = parseBRCurrency(document.getElementById('nw-discount').value);
    const total = Math.max(0, subtotal - disc);
    document.getElementById('nw-total-display').textContent = formatCents(total);
  }

  document.getElementById('nw-discount').addEventListener('input', updateTotal);
  renderCart();

  document.getElementById('nw-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('nw-save-btn');
    const customer_id = Number(custSelect.value);
    const picked_up_by = pickedInput.value.trim();
    const authVal = authSelect.value;
    const authorized_person_id = authVal && !authVal.startsWith('self:') ? Number(authVal) : null;

    if (!customer_id) return toast('Selecione um cliente.', true);
    if (!picked_up_by) return toast('Informe quem retirou os produtos.', true);
    if (state.cart.length === 0) return toast('Adicione pelo menos um produto.', true);

    btn.disabled = true;
    try {
      const created = await api('/api/withdrawals', {
        method: 'POST',
        body: JSON.stringify({
          customer_id,
          withdrawal_date: document.getElementById('nw-date').value,
          picked_up_by,
          authorized_person_id,
          work_reference: document.getElementById('nw-work').value.trim(),
          discount_cents: parseBRCurrency(document.getElementById('nw-discount').value),
          notes: document.getElementById('nw-notes').value.trim(),
          items: state.cart.map((it) => ({
            product_id: it.product_id,
            quantity: it.quantity,
            unit_price_cents: it.unit_price_cents,
          })),
          idempotency_key: state.withdrawalIdempotencyKey,
        }),
      });

      toast(`Retirada ${created.code} salva com sucesso!`);
      openModal(
        `Retirada ${created.code} Registrada`,
        `
          <p>A retirada foi vinculada à conta aberta de <strong>${escapeHtml(created.customer_name)}</strong>.</p>
          <p>Total: <strong>${formatCents(created.net_total_cents)}</strong></p>
          <div class="btn-group" style="margin-top:16px">
            <a href="/api/withdrawals/${created.id}/pdf" target="_blank" class="btn btn-primary btn-lg">🖨️ Imprimir / PDF Comprovante</a>
            <button class="btn btn-outline btn-lg" id="modal-new-w-btn">Nova Retirada</button>
          </div>
        `
      );
      document.getElementById('modal-new-w-btn').addEventListener('click', () => {
        closeModal();
        renderNewWithdrawal(container);
      });
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
}

// 3. CONTA ABERTA / RETIRADAS
async function renderWithdrawals(container) {
  const customers = await api('/api/customers');
  const f = state.withdrawalFilters;

  container.innerHTML = `
    <div class="page-header">
      <h1>Conta Aberta & Histórico de Retiradas</h1>
      <button class="btn btn-primary" id="w-new-btn">➕ Nova Retirada</button>
    </div>

    <div class="card">
      <div class="grid-4">
        <div>
          <label>Cliente</label>
          <select id="wf-customer">
            <option value="">Todos os clientes</option>
            ${customers.map((c) => `<option value="${c.id}" ${String(f.customer_id) === String(c.id) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Situação</label>
          <select id="wf-status">
            <option value="">Todas</option>
            <option value="aberta" ${f.status === 'aberta' ? 'selected' : ''}>Aberta</option>
            <option value="fechada" ${f.status === 'fechada' ? 'selected' : ''}>Fechada</option>
            <option value="cancelada" ${f.status === 'cancelada' ? 'selected' : ''}>Cancelada</option>
          </select>
        </div>
        <div>
          <label>Data Inicial</label>
          <input type="date" id="wf-start" value="${escapeHtml(f.start_date)}" />
        </div>
        <div>
          <label>Data Final</label>
          <input type="date" id="wf-end" value="${escapeHtml(f.end_date)}" />
        </div>
      </div>
      <div class="grid-3" style="margin-top:10px;align-items:end">
        <div>
          <label>Obra / Referência</label>
          <input type="text" id="wf-work" value="${escapeHtml(f.work_reference)}" placeholder="Filtrar por obra..." />
        </div>
        <div>
          <label>Pesquisa rápida</label>
          <input type="text" id="wf-q" value="${escapeHtml(f.q)}" placeholder="Código, cliente, portador..." />
        </div>
        <div class="btn-group">
          <button class="btn btn-dark" id="wf-apply">🔍 Filtrar</button>
          <button class="btn btn-outline" id="wf-clear">Limpar</button>
        </div>
      </div>
    </div>

    <div id="w-summary-bar" class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"></div>
    <div id="w-list"></div>
  `;

  document.getElementById('w-new-btn').addEventListener('click', () => navigate('new-withdrawal'));

  async function loadList() {
    const params = new URLSearchParams();
    if (f.customer_id) params.set('customer_id', f.customer_id);
    if (f.status) params.set('status', f.status);
    if (f.start_date) params.set('start_date', f.start_date);
    if (f.end_date) params.set('end_date', f.end_date);
    if (f.work_reference) params.set('work_reference', f.work_reference);
    if (f.q) params.set('q', f.q);

    const data = await api(`/api/withdrawals?${params.toString()}`);
    const isManager = ['admin', 'gerente'].includes(state.user.role);

    document.getElementById('w-summary-bar').innerHTML = `
      <div><strong>${data.summary.count}</strong> retirada(s) encontrada(s) (${data.summary.open_count} aberta(s))</div>
      <div style="font-size:1.15rem">Total Pendente de Fechamento: <strong style="color:var(--brand-orange-dark)">${formatCents(data.summary.open_total_cents)}</strong></div>
    `;

    const listEl = document.getElementById('w-list');
    if (data.withdrawals.length === 0) {
      listEl.innerHTML = '<div class="card muted">Nenhuma retirada encontrada para os filtros selecionados.</div>';
      return;
    }

    listEl.innerHTML = data.withdrawals
      .map(
        (w) => `
      <div class="withdrawal-card">
        <div class="withdrawal-card-header">
          <div>
            <strong style="font-size:1.05rem">${escapeHtml(w.code)}</strong>
            <span class="badge badge-${w.status}" style="margin-left:6px">${w.status}</span>
            ${w.order_number ? `<span class="badge badge-neutral" style="margin-left:4px">Pedido: ${escapeHtml(w.order_number)}</span>` : ''}
            <div class="muted" style="margin-top:4px">
              Cliente: <strong>${escapeHtml(w.customer_name)}</strong> • Data: <strong>${formatDateTime(w.withdrawal_date)}</strong> • Retirado por: <strong>${escapeHtml(w.picked_up_by)}</strong> • Atendente: ${escapeHtml(w.employee_name)}
              ${w.work_reference ? ` • Obra: <strong>${escapeHtml(w.work_reference)}</strong>` : ''}
            </div>
          </div>
          <div class="text-right">
            <div style="font-size:1.25rem;font-weight:800">${formatCents(w.net_total_cents)}</div>
            ${w.discount_cents > 0 ? `<div class="muted">Desc: -${formatCents(w.discount_cents)}</div>` : ''}
            ${w.returns_total_cents > 0 ? `<div style="color:var(--danger);font-size:0.85rem">Devol: -${formatCents(w.returns_total_cents)}</div>` : ''}
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead><tr><th>Código</th><th>Produto</th><th>Unid.</th><th class="text-right">Qtd.</th><th class="text-right">V. Unit.</th><th class="text-right">Subtotal</th></tr></thead>
            <tbody>
              ${w.items
                .map(
                  (it) => `<tr>
                    <td>${escapeHtml(it.product_code)}</td>
                    <td>${escapeHtml(it.product_description)}</td>
                    <td>${escapeHtml(it.product_unit)}</td>
                    <td class="text-right">${formatQty(it.quantity)}${it.returned_qty > 0 ? ` <span class="muted">(-${formatQty(it.returned_qty)} dev.)</span>` : ''}</td>
                    <td class="text-right">${formatCents(it.unit_price_cents)}</td>
                    <td class="text-right">${formatCents(it.subtotal_cents)}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>

        ${
          w.returns.length > 0
            ? `<div class="alert alert-warning" style="margin-top:10px">
                <strong>Devoluções:</strong>
                ${w.returns.map((r) => `<div>• ${formatDateTime(r.returned_at)} — ${escapeHtml(r.product_description)}: ${formatQty(r.quantity)} (${formatCents(r.refund_cents)}) — Motivo: ${escapeHtml(r.reason)}</div>`).join('')}
              </div>`
            : ''
        }

        ${
          w.corrections.length > 0
            ? `<div class="alert alert-info" style="margin-top:10px">
                <strong>Correções Pós-Fechamento:</strong>
                ${w.corrections.map((c) => `<div>• ${formatDateTime(c.created_at)} por ${escapeHtml(c.user_name)} — Motivo: ${escapeHtml(c.reason)}</div>`).join('')}
              </div>`
            : ''
        }

        <div class="btn-group" style="margin-top:12px">
          <a href="/api/withdrawals/${w.id}/pdf" target="_blank" class="btn btn-outline btn-sm">🖨️ Comprovante PDF</a>
          ${w.status === 'aberta' ? `<button class="btn btn-outline btn-sm w-return-btn" data-id="${w.id}">↩️ Registrar Devolução</button>` : ''}
          ${w.status === 'aberta' && isManager ? `<button class="btn btn-danger btn-sm w-cancel-btn" data-id="${w.id}">Cancelar</button>` : ''}
          ${w.status === 'fechada' && isManager ? `<button class="btn btn-dark btn-sm w-correct-btn" data-id="${w.id}">✏️ Correção Pós-Fechamento</button>` : ''}
        </div>
      </div>
    `
      )
      .join('');

    // Wire actions
    listEl.querySelectorAll('.w-return-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const w = data.withdrawals.find((x) => x.id === Number(btn.dataset.id));
        openReturnModal(w, loadList);
      });
    });

    listEl.querySelectorAll('.w-cancel-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const w = data.withdrawals.find((x) => x.id === Number(btn.dataset.id));
        openCancelModal(w, loadList);
      });
    });

    listEl.querySelectorAll('.w-correct-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const w = data.withdrawals.find((x) => x.id === Number(btn.dataset.id));
        openCorrectionModal(w, loadList);
      });
    });
  }

  document.getElementById('wf-apply').addEventListener('click', () => {
    f.customer_id = document.getElementById('wf-customer').value;
    f.status = document.getElementById('wf-status').value;
    f.start_date = document.getElementById('wf-start').value;
    f.end_date = document.getElementById('wf-end').value;
    f.work_reference = document.getElementById('wf-work').value;
    f.q = document.getElementById('wf-q').value;
    loadList();
  });

  document.getElementById('wf-clear').addEventListener('click', () => {
    state.withdrawalFilters = { customer_id: '', status: '', start_date: '', end_date: '', work_reference: '', q: '' };
    renderWithdrawals(container);
  });

  await loadList();
}

function openReturnModal(w, onDone) {
  const returnable = w.items.filter((it) => it.remaining_qty > 0);
  if (returnable.length === 0) {
    return toast('Todos os itens desta retirada já foram devolvidos.', true);
  }
  openModal(
    `Devolução — ${w.code}`,
    `
      <form id="ret-form" class="form-stack">
        <div>
          <label>Produto *</label>
          <select id="ret-item" required>
            ${returnable.map((it) => `<option value="${it.id}">${escapeHtml(it.product_description)} (Disponível: ${formatQty(it.remaining_qty)} ${escapeHtml(it.product_unit)})</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Quantidade a Devolver *</label>
          <input type="text" id="ret-qty" required value="1" />
        </div>
        <div>
          <label>Motivo da Devolução *</label>
          <input type="text" id="ret-reason" required placeholder="Ex: Sobra de obra, item errado..." />
        </div>
        <button type="submit" class="btn btn-primary btn-lg">Confirmar Devolução</button>
      </form>
    `
  );
  document.getElementById('ret-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/withdrawals/${w.id}/returns`, {
        method: 'POST',
        body: JSON.stringify({
          withdrawal_item_id: Number(document.getElementById('ret-item').value),
          quantity: document.getElementById('ret-qty').value,
          reason: document.getElementById('ret-reason').value,
        }),
      });
      toast('Devolução registrada com sucesso!');
      closeModal();
      await onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function openCancelModal(w, onDone) {
  openModal(
    `Cancelar Retirada — ${w.code}`,
    `
      <form id="cancel-form" class="form-stack">
        <p>Esta ação marcará a retirada como <strong>CANCELADA</strong> e ela não poderá ser fechada em pedido.</p>
        <div>
          <label>Motivo do Cancelamento *</label>
          <input type="text" id="cancel-reason" required placeholder="Descreva o motivo..." />
        </div>
        <button type="submit" class="btn btn-danger btn-lg">Confirmar Cancelamento</button>
      </form>
    `
  );
  document.getElementById('cancel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/withdrawals/${w.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: document.getElementById('cancel-reason').value }),
      });
      toast('Retirada cancelada.');
      closeModal();
      await onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function openCorrectionModal(w, onDone) {
  openModal(
    `Correção Pós-Fechamento — ${w.code}`,
    `
      <form id="corr-form" class="form-stack">
        <div class="alert alert-warning">Os dados anteriores serão preservados no histórico de auditoria.</div>
        <div>
          <label>Motivo da Correção *</label>
          <input type="text" id="corr-reason" required placeholder="Obrigatório informar o motivo..." />
        </div>
        <div>
          <label>Retirado por</label>
          <input type="text" id="corr-picked" value="${escapeHtml(w.picked_up_by)}" />
        </div>
        <div>
          <label>Obra / Referência</label>
          <input type="text" id="corr-work" value="${escapeHtml(w.work_reference || '')}" />
        </div>
        <div>
          <label>Desconto (R$)</label>
          <input type="text" id="corr-disc" value="${(w.discount_cents / 100).toFixed(2).replace('.', ',')}" />
        </div>
        <div>
          <label>Observações</label>
          <textarea id="corr-notes" rows="2">${escapeHtml(w.notes || '')}</textarea>
        </div>
        <button type="submit" class="btn btn-dark btn-lg">Salvar Correção</button>
      </form>
    `
  );
  document.getElementById('corr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/withdrawals/${w.id}/correct`, {
        method: 'POST',
        body: JSON.stringify({
          reason: document.getElementById('corr-reason').value,
          picked_up_by: document.getElementById('corr-picked').value,
          work_reference: document.getElementById('corr-work').value,
          discount: document.getElementById('corr-disc').value,
          notes: document.getElementById('corr-notes').value,
        }),
      });
      toast('Correção registrada com histórico preservado!');
      closeModal();
      await onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// 4. FECHAMENTO E PEDIDOS
async function renderClosingAndOrders(container, ordersOnly = false) {
  const [customers, orders] = await Promise.all([
    api('/api/customers'),
    api('/api/orders'),
  ]);

  container.innerHTML = `
    <div class="page-header">
      <h1>${ordersOnly ? 'Pedidos Gerados' : 'Fechamento de Conta e Pedidos'}</h1>
    </div>

    ${
      ordersOnly
        ? ''
        : `<div class="card">
            <h2 class="card-title">Fechar Retiradas e Gerar Pedido</h2>
            <div class="grid-4" style="align-items:end">
              <div>
                <label>Cliente *</label>
                <select id="cl-customer">
                  <option value="">-- Selecione --</option>
                  ${customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
                </select>
              </div>
              <div>
                <label>Data Inicial</label>
                <input type="date" id="cl-start" />
              </div>
              <div>
                <label>Data Final</label>
                <input type="date" id="cl-end" />
              </div>
              <div>
                <button class="btn btn-dark btn-lg" id="cl-search-btn" style="width:100%">🔍 Buscar Retiradas Abertas</button>
              </div>
            </div>
            <div id="cl-preview-area" style="margin-top:16px"></div>
          </div>`
    }

    <div class="card">
      <h2 class="card-title">Pedidos Gerados</h2>
      ${
        orders.length === 0
          ? '<p class="muted">Nenhum pedido gerado ainda.</p>'
          : `<div class="table-wrap"><table>
              <thead><tr><th>Nº Pedido</th><th>Emissão</th><th>Cliente</th><th>Período</th><th class="text-center">Retiradas</th><th class="text-right">Total</th><th></th></tr></thead>
              <tbody>
                ${orders
                  .map(
                    (o) => `<tr>
                      <td><strong>${escapeHtml(o.order_number)}</strong></td>
                      <td>${formatDateTime(o.issued_at)}</td>
                      <td>${escapeHtml(o.customer_name)}</td>
                      <td>${formatDate(o.period_start)} a ${formatDate(o.period_end)}</td>
                      <td class="text-center">${o.withdrawals_count}</td>
                      <td class="text-right"><strong>${formatCents(o.total_cents)}</strong></td>
                      <td class="text-right">
                        <div class="btn-group" style="justify-content:flex-end">
                          <button class="btn btn-outline btn-sm view-order-btn" data-id="${o.id}">Visualizar</button>
                          <a href="/api/orders/${o.id}/pdf?mode=consolidated" target="_blank" class="btn btn-primary btn-sm">PDF</a>
                        </div>
                      </td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
            </table></div>`
      }
    </div>
  `;

  container.querySelectorAll('.view-order-btn').forEach((btn) => {
    btn.addEventListener('click', () => openOrderModal(Number(btn.dataset.id)));
  });

  if (!ordersOnly) {
    document.getElementById('cl-search-btn').addEventListener('click', () => loadClosingPreview(container));
  }
}

async function loadClosingPreview(container, selectedIds = null) {
  const customer_id = document.getElementById('cl-customer').value;
  const period_start = document.getElementById('cl-start').value;
  const period_end = document.getElementById('cl-end').value;
  if (!customer_id) return toast('Selecione um cliente.', true);

  state.closingIdempotencyKey = genKey();
  const preview = await api('/api/orders/preview', {
    method: 'POST',
    body: JSON.stringify({
      customer_id: Number(customer_id),
      period_start,
      period_end,
      withdrawal_ids: selectedIds,
    }),
  });

  const area = document.getElementById('cl-preview-area');
  if (preview.available_withdrawals.length === 0) {
    area.innerHTML = '<div class="alert alert-info">Nenhuma retirada aberta encontrada para este cliente no período informado.</div>';
    return;
  }

  const selSet = new Set(preview.selected_withdrawals.map((w) => w.id));

  area.innerHTML = `
    <h3 style="margin:0 0 8px">1. Selecione as Retiradas para Incluir no Pedido</h3>
    <div class="table-wrap" style="margin-bottom:14px">
      <table>
        <thead><tr><th style="width:40px">Inc.</th><th>Código</th><th>Data/Hora</th><th>Obra</th><th>Retirado por</th><th class="text-right">Total Líq.</th></tr></thead>
        <tbody>
          ${preview.available_withdrawals
            .map(
              (w) => `<tr>
                <td><input type="checkbox" class="cl-w-check" value="${w.id}" ${selSet.has(w.id) ? 'checked' : ''} style="width:20px;height:20px" /></td>
                <td><strong>${escapeHtml(w.code)}</strong></td>
                <td>${formatDateTime(w.withdrawal_date)}</td>
                <td>${escapeHtml(w.work_reference || '-')}</td>
                <td>${escapeHtml(w.picked_up_by)}</td>
                <td class="text-right"><strong>${formatCents(w.net_total_cents)}</strong></td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <h3 style="margin:0 0 8px">2. Prévia do Pedido Consolidado (Pedido — sem valor fiscal)</h3>
    <div class="table-wrap" style="margin-bottom:14px">
      <table>
        <thead><tr><th>Código</th><th>Produto</th><th>Unid.</th><th class="text-right">Qtd.</th><th class="text-right">V. Unit.</th><th class="text-right">Subtotal</th></tr></thead>
        <tbody>
          ${preview.consolidated_items
            .map(
              (it) => `<tr>
                <td>${escapeHtml(it.product_code)}</td>
                <td>${escapeHtml(it.product_description)}</td>
                <td>${escapeHtml(it.product_unit)}</td>
                <td class="text-right">${formatQty(it.quantity)}</td>
                <td class="text-right">${formatCents(it.unit_price_cents)}</td>
                <td class="text-right">${formatCents(it.subtotal_cents)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="grid-3" style="margin-bottom:14px">
      <div>
        <label>Condição de Pagamento</label>
        <input type="text" id="cl-pay-cond" placeholder="Ex: 30 dias / PIX / Boleto" />
      </div>
      <div>
        <label>Vencimento</label>
        <input type="date" id="cl-due-date" />
      </div>
      <div>
        <label>Desconto Adicional no Fechamento (R$)</label>
        <input type="text" id="cl-extra-disc" value="0,00" />
      </div>
    </div>
    <div style="margin-bottom:14px">
      <label>Observações do Pedido</label>
      <input type="text" id="cl-notes" placeholder="Observações opcionais..." />
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid var(--border)">
      <div>
        <div>Subtotal Bruto: <strong>${formatCents(preview.subtotal_cents)}</strong> | Devoluções: <strong>-${formatCents(preview.returns_cents)}</strong> | Descontos: <strong>-${formatCents(preview.discount_cents)}</strong></div>
        <div style="font-size:1.35rem;font-weight:800;margin-top:4px">Total do Pedido: ${formatCents(preview.total_cents)}</div>
      </div>
      <button class="btn btn-success btn-lg" id="cl-confirm-btn">✅ Confirmar Fechamento e Gerar Pedido</button>
    </div>
  `;

  area.querySelectorAll('.cl-w-check').forEach((chk) => {
    chk.addEventListener('change', () => {
      const checked = Array.from(area.querySelectorAll('.cl-w-check:checked')).map((c) => Number(c.value));
      if (checked.length === 0) {
        toast('Mantenha pelo menos uma retirada selecionada.', true);
        chk.checked = true;
        return;
      }
      loadClosingPreview(container, checked);
    });
  });

  document.getElementById('cl-confirm-btn').addEventListener('click', async () => {
    const btn = document.getElementById('cl-confirm-btn');
    const checked = Array.from(area.querySelectorAll('.cl-w-check:checked')).map((c) => Number(c.value));
    if (checked.length === 0) return toast('Selecione ao menos uma retirada.', true);

    btn.disabled = true;
    try {
      const order = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: Number(customer_id),
          period_start,
          period_end,
          withdrawal_ids: checked,
          payment_condition: document.getElementById('cl-pay-cond').value,
          due_date: document.getElementById('cl-due-date').value,
          extra_discount: document.getElementById('cl-extra-disc').value,
          notes: document.getElementById('cl-notes').value,
          idempotency_key: state.closingIdempotencyKey,
        }),
      });
      toast(`Pedido ${order.order_number} gerado com sucesso!`);
      await renderClosingAndOrders(container, false);
      await openOrderModal(order.id);
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
}

async function openOrderModal(orderId) {
  const o = await api(`/api/orders/${orderId}`);
  openModal(
    `Pedido ${o.order_number}`,
    `
      <div class="alert alert-warning" style="text-align:center;font-weight:700;margin-bottom:12px">
        PEDIDO — SEM VALOR FISCAL
      </div>
      <div style="margin-bottom:12px">
        <strong>Cliente:</strong> ${escapeHtml(o.customer.name)}<br>
        <strong>Período:</strong> ${formatDate(o.period_start)} a ${formatDate(o.period_end)} | <strong>Emissão:</strong> ${formatDateTime(o.issued_at)}<br>
        <strong>Retiradas de origem:</strong> ${o.withdrawals.map((w) => escapeHtml(w.code)).join(', ')}
        ${o.payment_condition ? `<br><strong>Cond. Pagamento:</strong> ${escapeHtml(o.payment_condition)}` : ''}
        ${o.due_date ? ` | <strong>Vencimento:</strong> ${formatDate(o.due_date)}` : ''}
      </div>

      <div class="tabs">
        <button class="tab-btn active" id="ord-tab-cons">Resumo Consolidado</button>
        <button class="tab-btn" id="ord-tab-det">Detalhamento por Data</button>
      </div>

      <div id="ord-view-cons">
        <div class="table-wrap"><table>
          <thead><tr><th>Código</th><th>Produto</th><th>Unid.</th><th class="text-right">Qtd.</th><th class="text-right">V. Unit.</th><th class="text-right">Total</th></tr></thead>
          <tbody>
            ${o.consolidated_items
              .map(
                (it) => `<tr>
                  <td>${escapeHtml(it.product_code)}</td>
                  <td>${escapeHtml(it.product_description)}</td>
                  <td>${escapeHtml(it.product_unit)}</td>
                  <td class="text-right">${formatQty(it.quantity)}</td>
                  <td class="text-right">${formatCents(it.unit_price_cents)}</td>
                  <td class="text-right">${formatCents(it.subtotal_cents)}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table></div>
      </div>

      <div id="ord-view-det" class="hidden">
        ${o.withdrawals
          .map(
            (w) => `
          <div style="margin-bottom:12px;padding:10px;border:1px solid var(--border);border-radius:8px">
            <strong>${escapeHtml(w.code)}</strong> — ${formatDateTime(w.withdrawal_date)} — Retirado por: ${escapeHtml(w.picked_up_by)}
            <table style="margin-top:6px">
              <thead><tr><th>Produto</th><th class="text-right">Qtd</th><th class="text-right">V. Unit</th><th class="text-right">Subtotal</th></tr></thead>
              <tbody>
                ${w.items.map((it) => `<tr><td>${escapeHtml(it.product_description)}</td><td class="text-right">${formatQty(it.quantity)} ${escapeHtml(it.product_unit)}</td><td class="text-right">${formatCents(it.unit_price_cents)}</td><td class="text-right">${formatCents(it.subtotal_cents)}</td></tr>`).join('')}
              </tbody>
            </table>
          </div>`
          )
          .join('')}
      </div>

      <div style="margin-top:14px;text-align:right;font-size:1.15rem">
        Subtotal: ${formatCents(o.subtotal_cents)} | Devoluções: -${formatCents(o.returns_cents)} | Descontos: -${formatCents(o.discount_cents)}<br>
        <strong style="font-size:1.35rem">TOTAL GERAL: ${formatCents(o.total_cents)}</strong>
      </div>

      <div class="btn-group" style="margin-top:16px">
        <a href="/api/orders/${o.id}/pdf?mode=consolidated" target="_blank" class="btn btn-primary">📄 PDF Consolidado</a>
        <a href="/api/orders/${o.id}/pdf?mode=detailed" target="_blank" class="btn btn-dark">📄 PDF Detalhado</a>
        <a href="/api/orders/${o.id}/pdf?mode=both" target="_blank" class="btn btn-outline">📄 PDF Completo (Ambos)</a>
      </div>
    `
  );

  const tabCons = document.getElementById('ord-tab-cons');
  const tabDet = document.getElementById('ord-tab-det');
  const viewCons = document.getElementById('ord-view-cons');
  const viewDet = document.getElementById('ord-view-det');

  tabCons.addEventListener('click', () => {
    tabCons.classList.add('active');
    tabDet.classList.remove('active');
    viewCons.classList.remove('hidden');
    viewDet.classList.add('hidden');
  });
  tabDet.addEventListener('click', () => {
    tabDet.classList.add('active');
    tabCons.classList.remove('active');
    viewDet.classList.remove('hidden');
    viewCons.classList.add('hidden');
  });
}

// 5. CLIENTES
async function renderCustomers(container) {
  const customers = await api('/api/customers');
  container.innerHTML = `
    <div class="page-header">
      <h1>Cadastro de Clientes</h1>
      <div class="btn-group">
        <button class="btn btn-outline btn-lg" id="cust-import-btn">📥 Importar Planilha</button>
        <button class="btn btn-primary btn-lg" id="cust-new-btn">➕ Novo Cliente</button>
      </div>
    </div>
    <div class="card">
      <input type="text" id="cust-search" placeholder="Pesquisar por nome, CPF/CNPJ ou telefone..." />
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Nome / Razão Social</th><th>CPF/CNPJ</th><th>Telefone/WhatsApp</th><th>Autorizados</th><th>Situação</th><th></th></tr></thead>
          <tbody id="cust-tbody"></tbody>
        </table>
      </div>
    </div>
  `;

  function drawTable(q = '') {
    const term = q.trim().toLowerCase();
    const list = term
      ? customers.filter(
          (c) =>
            c.name.toLowerCase().includes(term) ||
            (c.document || '').toLowerCase().includes(term) ||
            (c.phone || '').toLowerCase().includes(term)
        )
      : customers;

    document.getElementById('cust-tbody').innerHTML = list
      .map(
        (c) => `<tr>
          <td><strong>${escapeHtml(c.name)}</strong><br><span class="muted">${escapeHtml(c.address || '')}</span></td>
          <td>${escapeHtml(c.document || '-')}</td>
          <td>${escapeHtml(c.phone || '-')}</td>
          <td>${(c.authorized_people || []).length} pessoa(s)</td>
          <td><span class="badge badge-${c.status}">${c.status}</span></td>
          <td class="text-right">
            <div class="btn-group" style="justify-content:flex-end">
              <button class="btn btn-outline btn-sm cust-auth-btn" data-id="${c.id}">Autorizados</button>
              <button class="btn btn-dark btn-sm cust-edit-btn" data-id="${c.id}">Editar</button>
            </div>
          </td>
        </tr>`
      )
      .join('');

    document.querySelectorAll('.cust-edit-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const c = customers.find((x) => x.id === Number(b.dataset.id));
        openCustomerModal(c, () => renderCustomers(container));
      });
    });
    document.querySelectorAll('.cust-auth-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const c = customers.find((x) => x.id === Number(b.dataset.id));
        openAuthorizedPeopleModal(c, () => renderCustomers(container));
      });
    });
  }

  document.getElementById('cust-search').addEventListener('input', (e) => drawTable(e.target.value));
  document.getElementById('cust-import-btn').addEventListener('click', () =>
    openImportModal({
      title: 'Importar Clientes (Excel ou CSV)',
      templateUrl: '/api/customers/import/template',
      importUrl: '/api/customers/import',
      onDone: () => renderCustomers(container),
    })
  );
  document.getElementById('cust-new-btn').addEventListener('click', () =>
    openCustomerModal(null, () => renderCustomers(container))
  );
  drawTable();
}

function openCustomerModal(customer, onDone) {
  openModal(
    customer ? `Editar Cliente — ${customer.name}` : 'Novo Cliente',
    `
      <form id="cust-form" class="form-stack">
        <div>
          <label>Nome ou Razão Social *</label>
          <input type="text" id="cf-name" required value="${escapeHtml(customer?.name || '')}" />
        </div>
        <div class="grid-2">
          <div>
            <label>CPF / CNPJ (opcional)</label>
            <input type="text" id="cf-doc" value="${escapeHtml(customer?.document || '')}" />
          </div>
          <div>
            <label>Telefone / WhatsApp</label>
            <input type="text" id="cf-phone" value="${escapeHtml(customer?.phone || '')}" />
          </div>
        </div>
        <div>
          <label>Endereço</label>
          <input type="text" id="cf-addr" value="${escapeHtml(customer?.address || '')}" />
        </div>
        <div class="grid-2">
          <div>
            <label>Situação</label>
            <select id="cf-status">
              <option value="ativo" ${customer?.status !== 'inativo' ? 'selected' : ''}>Ativo</option>
              <option value="inativo" ${customer?.status === 'inativo' ? 'selected' : ''}>Inativo</option>
            </select>
          </div>
        </div>
        <div>
          <label>Observações</label>
          <textarea id="cf-notes" rows="2">${escapeHtml(customer?.notes || '')}</textarea>
        </div>
        <button type="submit" class="btn btn-primary btn-lg">Salvar Cliente</button>
      </form>
    `
  );
  document.getElementById('cust-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('cf-name').value,
      document: document.getElementById('cf-doc').value,
      phone: document.getElementById('cf-phone').value,
      address: document.getElementById('cf-addr').value,
      status: document.getElementById('cf-status').value,
      notes: document.getElementById('cf-notes').value,
    };
    try {
      if (customer) {
        await api(`/api/customers/${customer.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/customers', { method: 'POST', body: JSON.stringify(payload) });
      }
      toast('Cliente salvo com sucesso!');
      closeModal();
      await onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function openAuthorizedPeopleModal(customer, onDone) {
  const full = await api(`/api/customers/${customer.id}`);
  const activePeople = (full.authorized_people || []).filter((p) => p.active);

  openModal(
    `Pessoas Autorizadas — ${customer.name}`,
    `
      <form id="auth-p-form" class="grid-3" style="align-items:end;margin-bottom:16px">
        <div>
          <label>Nome *</label>
          <input type="text" id="ap-name" required placeholder="Nome completo" />
        </div>
        <div>
          <label>Identificação (RG/CPF/Cargo)</label>
          <input type="text" id="ap-ident" placeholder="Ex: Eletricista / RG 123" />
        </div>
        <button type="submit" class="btn btn-primary">Adicionar</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Nome</th><th>Identificação</th><th></th></tr></thead>
          <tbody>
            ${
              activePeople.length === 0
                ? '<tr><td colspan="3" class="muted">Nenhuma pessoa autorizada cadastrada.</td></tr>'
                : activePeople
                    .map(
                      (p) => `<tr>
                        <td><strong>${escapeHtml(p.name)}</strong></td>
                        <td>${escapeHtml(p.identification || '-')}</td>
                        <td class="text-right"><button class="btn btn-danger btn-sm ap-del" data-pid="${p.id}">Remover</button></td>
                      </tr>`
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    `
  );

  document.getElementById('auth-p-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/customers/${customer.id}/authorized-people`, {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('ap-name').value,
          identification: document.getElementById('ap-ident').value,
        }),
      });
      toast('Pessoa autorizada adicionada!');
      await openAuthorizedPeopleModal(customer, onDone);
      await onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.querySelectorAll('.ap-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/customers/${customer.id}/authorized-people/${btn.dataset.pid}`, {
        method: 'DELETE',
      });
      toast('Pessoa removida.');
      await openAuthorizedPeopleModal(customer, onDone);
      await onDone();
    });
  });
}

// 6. PRODUTOS
async function renderProducts(container) {
  const products = await api('/api/products');
  container.innerHTML = `
    <div class="page-header">
      <h1>Cadastro de Produtos</h1>
      <div class="btn-group">
        <button class="btn btn-outline btn-lg" id="prod-import-btn">📥 Importar Planilha</button>
        <button class="btn btn-primary btn-lg" id="prod-new-btn">➕ Novo Produto</button>
      </div>
    </div>
    <div class="card">
      <input type="text" id="prod-search" placeholder="Pesquisar por código, código de barras, descrição ou marca..." />
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Código</th><th>Descrição</th><th>Marca / Categoria</th><th>Unid.</th><th class="text-right">Preço</th><th>Situação</th><th></th></tr></thead>
          <tbody id="prod-tbody"></tbody>
        </table>
      </div>
    </div>
  `;

  function drawTable(q = '') {
    const term = q.trim().toLowerCase();
    const list = term
      ? products.filter(
          (p) =>
            p.internal_code.toLowerCase().includes(term) ||
            (p.barcode || '').toLowerCase().includes(term) ||
            p.description.toLowerCase().includes(term) ||
            (p.brand || '').toLowerCase().includes(term)
        )
      : products;

    document.getElementById('prod-tbody').innerHTML = list
      .map(
        (p) => `<tr>
          <td><strong>${escapeHtml(p.internal_code)}</strong>${p.barcode ? `<br><span class="muted">${escapeHtml(p.barcode)}</span>` : ''}</td>
          <td>${escapeHtml(p.description)}</td>
          <td>${escapeHtml(p.brand || '-')} <span class="muted">/ ${escapeHtml(p.category || '-')}</span></td>
          <td>${escapeHtml(p.unit)}</td>
          <td class="text-right"><strong>${formatCents(p.price_cents)}</strong></td>
          <td><span class="badge badge-${p.status}">${p.status}</span></td>
          <td class="text-right"><button class="btn btn-dark btn-sm prod-edit-btn" data-id="${p.id}">Editar</button></td>
        </tr>`
      )
      .join('');

    document.querySelectorAll('.prod-edit-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const p = products.find((x) => x.id === Number(b.dataset.id));
        openProductModal(p, () => renderProducts(container));
      });
    });
  }

  document.getElementById('prod-search').addEventListener('input', (e) => drawTable(e.target.value));
  document.getElementById('prod-import-btn').addEventListener('click', () =>
    openImportModal({
      title: 'Importar Produtos (Excel ou CSV)',
      templateUrl: '/api/products/import/template',
      importUrl: '/api/products/import',
      onDone: () => renderProducts(container),
    })
  );
  document.getElementById('prod-new-btn').addEventListener('click', () =>
    openProductModal(null, () => renderProducts(container))
  );
  drawTable();
}

function openProductModal(product, onDone) {
  openModal(
    product ? `Editar Produto — ${product.internal_code}` : 'Novo Produto',
    `
      <form id="prod-form" class="form-stack">
        <div class="grid-2">
          <div>
            <label>Código Interno *</label>
            <input type="text" id="pf-code" required value="${escapeHtml(product?.internal_code || '')}" />
          </div>
          <div>
            <label>Código de Barras (opcional)</label>
            <input type="text" id="pf-bar" value="${escapeHtml(product?.barcode || '')}" />
          </div>
        </div>
        <div>
          <label>Descrição *</label>
          <input type="text" id="pf-desc" required value="${escapeHtml(product?.description || '')}" />
        </div>
        <div class="grid-2">
          <div>
            <label>Marca</label>
            <input type="text" id="pf-brand" value="${escapeHtml(product?.brand || '')}" />
          </div>
          <div>
            <label>Categoria</label>
            <input type="text" id="pf-cat" value="${escapeHtml(product?.category || '')}" />
          </div>
        </div>
        <div class="grid-3">
          <div>
            <label>Unidade de Medida *</label>
            <select id="pf-unit">
              ${['unidade', 'metro', 'rolo', 'caixa', 'pacote', 'peça', 'kg', 'litro']
                .map((u) => `<option value="${u}" ${product?.unit === u ? 'selected' : ''}>${u}</option>`)
                .join('')}
            </select>
          </div>
          <div>
            <label>Preço de Venda (R$) *</label>
            <input type="text" id="pf-price" required value="${product ? (product.price_cents / 100).toFixed(2).replace('.', ',') : ''}" placeholder="0,00" />
          </div>
          <div>
            <label>Situação</label>
            <select id="pf-status">
              <option value="ativo" ${product?.status !== 'inativo' ? 'selected' : ''}>Ativo</option>
              <option value="inativo" ${product?.status === 'inativo' ? 'selected' : ''}>Inativo</option>
            </select>
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-lg">Salvar Produto</button>
      </form>
    `
  );
  document.getElementById('prod-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      internal_code: document.getElementById('pf-code').value,
      barcode: document.getElementById('pf-bar').value,
      description: document.getElementById('pf-desc').value,
      brand: document.getElementById('pf-brand').value,
      category: document.getElementById('pf-cat').value,
      unit: document.getElementById('pf-unit').value,
      price: document.getElementById('pf-price').value,
      status: document.getElementById('pf-status').value,
    };
    try {
      if (product) {
        await api(`/api/products/${product.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/products', { method: 'POST', body: JSON.stringify(payload) });
      }
      toast('Produto salvo com sucesso!');
      closeModal();
      await onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// 7. RELATÓRIOS
async function renderReports(container) {
  const customers = await api('/api/customers');
  container.innerHTML = `
    <div class="page-header">
      <h1>Relatórios</h1>
    </div>
    <div class="card">
      <div class="grid-4">
        <div>
          <label>Tipo de Relatório</label>
          <select id="rep-type">
            <option value="customer">Por Cliente</option>
            <option value="period">Por Período (Retiradas)</option>
            <option value="product">Por Produto</option>
          </select>
        </div>
        <div>
          <label>Cliente (opcional)</label>
          <select id="rep-customer">
            <option value="">Todos</option>
            ${customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Data Inicial</label>
          <input type="date" id="rep-start" />
        </div>
        <div>
          <label>Data Final</label>
          <input type="date" id="rep-end" />
        </div>
      </div>
      <div class="btn-group" style="margin-top:12px">
        <button class="btn btn-dark" id="rep-run">📊 Gerar Relatório</button>
        <a id="rep-pdf" target="_blank" class="btn btn-primary">📄 Exportar PDF</a>
        <a id="rep-xlsx" class="btn btn-success">📗 Exportar Excel (.xlsx)</a>
      </div>
    </div>
    <div id="rep-result" class="card"></div>
  `;

  async function runReport() {
    const params = new URLSearchParams({
      type: document.getElementById('rep-type').value,
      customer_id: document.getElementById('rep-customer').value,
      start_date: document.getElementById('rep-start').value,
      end_date: document.getElementById('rep-end').value,
    });
    document.getElementById('rep-pdf').href = `/api/reports/export/pdf?${params.toString()}`;
    document.getElementById('rep-xlsx').href = `/api/reports/export/excel?${params.toString()}`;

    const data = await api(`/api/reports/data?${params.toString()}`);
    const resEl = document.getElementById('rep-result');

    if (data.type === 'customer') {
      resEl.innerHTML = `
        <div class="table-wrap"><table>
          <thead><tr><th>Cliente</th><th class="text-right">Abertas</th><th class="text-right">Valor Aberto</th><th class="text-right">Fechadas</th><th class="text-right">Valor Fechado</th><th class="text-right">Total</th></tr></thead>
          <tbody>
            ${data.items.map((c) => `<tr><td><strong>${escapeHtml(c.customer_name)}</strong></td><td class="text-right">${c.open_count}</td><td class="text-right">${formatCents(c.open_cents)}</td><td class="text-right">${c.closed_count}</td><td class="text-right">${formatCents(c.closed_cents)}</td><td class="text-right"><strong>${formatCents(c.total_cents)}</strong></td></tr>`).join('')}
          </tbody>
        </table></div>
        <div class="text-right" style="margin-top:12px;font-size:1.15rem"><strong>Total Geral: ${formatCents(data.total_cents)}</strong></div>
      `;
    } else if (data.type === 'product') {
      resEl.innerHTML = `
        <div class="table-wrap"><table>
          <thead><tr><th>Código</th><th>Produto</th><th>Unid.</th><th class="text-right">Qtd. Total</th><th class="text-right">Movs.</th><th class="text-right">Total</th></tr></thead>
          <tbody>
            ${data.items.map((p) => `<tr><td>${escapeHtml(p.product_code)}</td><td><strong>${escapeHtml(p.product_description)}</strong></td><td>${escapeHtml(p.product_unit)}</td><td class="text-right">${formatQty(p.total_qty)}</td><td class="text-right">${p.withdrawals_count}</td><td class="text-right"><strong>${formatCents(p.total_cents)}</strong></td></tr>`).join('')}
          </tbody>
        </table></div>
        <div class="text-right" style="margin-top:12px;font-size:1.15rem"><strong>Total Geral: ${formatCents(data.total_cents)}</strong></div>
      `;
    } else {
      resEl.innerHTML = `
        <div class="table-wrap"><table>
          <thead><tr><th>Código</th><th>Data/Hora</th><th>Cliente</th><th>Retirado por</th><th>Status</th><th class="text-right">Total Líq.</th></tr></thead>
          <tbody>
            ${data.items.map((w) => `<tr><td><strong>${escapeHtml(w.code)}</strong></td><td>${formatDateTime(w.withdrawal_date)}</td><td>${escapeHtml(w.customer_name)}</td><td>${escapeHtml(w.picked_up_by)}</td><td><span class="badge badge-${w.status}">${w.status}</span></td><td class="text-right"><strong>${formatCents(w.net_total_cents)}</strong></td></tr>`).join('')}
          </tbody>
        </table></div>
        <div class="text-right" style="margin-top:12px;font-size:1.15rem"><strong>Total Geral: ${formatCents(data.total_cents)}</strong></div>
      `;
    }
  }

  document.getElementById('rep-run').addEventListener('click', runReport);
  await runReport();
}

// 8. ADMINISTRAÇÃO
async function renderAdmin(container) {
  const isAdmin = state.user.role === 'admin';
  const [logs, users, settings, backups] = await Promise.all([
    api('/api/admin/audit-logs?limit=80'),
    isAdmin ? api('/api/admin/users') : Promise.resolve([]),
    isAdmin ? api('/api/admin/settings') : Promise.resolve(null),
    isAdmin ? api('/api/admin/backups') : Promise.resolve([]),
  ]);

  container.innerHTML = `
    <div class="page-header">
      <h1>Administração & Segurança</h1>
    </div>

    ${
      isAdmin
        ? `
      <div class="grid-2">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h2 class="card-title" style="margin:0">Usuários do Sistema</h2>
            <button class="btn btn-primary btn-sm" id="adm-new-user">➕ Novo Usuário</button>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${users
                .map(
                  (u) => `<tr>
                    <td>${escapeHtml(u.name)}</td>
                    <td>${escapeHtml(u.username)}</td>
                    <td><span class="badge badge-orange">${escapeHtml(u.role)}</span></td>
                    <td><span class="badge badge-${u.active ? 'ativo' : 'inativo'}">${u.active ? 'Ativo' : 'Inativo'}</span></td>
                    <td class="text-right"><button class="btn btn-outline btn-sm adm-edit-user" data-id="${u.id}">Editar</button></td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table></div>
        </div>

        <div class="card">
          <h2 class="card-title">Dados da Loja (Comprovantes e Pedidos)</h2>
          <form id="adm-settings-form" class="form-stack">
            <div><label>Nome da Loja</label><input type="text" id="set-name" value="${escapeHtml(settings.name)}" /></div>
            <div><label>Subtítulo</label><input type="text" id="set-sub" value="${escapeHtml(settings.subtitle)}" /></div>
            <div class="grid-2">
              <div><label>CNPJ</label><input type="text" id="set-cnpj" value="${escapeHtml(settings.cnpj)}" /></div>
              <div><label>Telefone / WhatsApp</label><input type="text" id="set-phone" value="${escapeHtml(settings.phone)}" /></div>
            </div>
            <div><label>Endereço</label><input type="text" id="set-addr" value="${escapeHtml(settings.address)}" /></div>
            <button type="submit" class="btn btn-dark">Salvar Dados da Loja</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <h2 class="card-title" style="margin:0">Backups do Banco de Dados (Automático a cada 6h)</h2>
          <button class="btn btn-primary btn-sm" id="adm-backup-now">💾 Gerar Backup Agora</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Arquivo</th><th>Data</th><th class="text-right">Tamanho</th><th></th></tr></thead>
          <tbody>
            ${backups
              .map(
                (b) => `<tr>
                  <td>${escapeHtml(b.filename)}</td>
                  <td>${new Date(b.createdAt).toLocaleString('pt-BR')}</td>
                  <td class="text-right">${(b.size / 1024).toFixed(1)} KB</td>
                  <td class="text-right"><a href="/api/admin/backups/${encodeURIComponent(b.filename)}" class="btn btn-outline btn-sm">Baixar</a></td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table></div>
      </div>`
        : ''
    }

    <div class="card">
      <h2 class="card-title">Histórico de Alterações (Auditoria)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Data/Hora</th><th>Usuário</th><th>Ação</th><th>Entidade</th><th>Motivo / Detalhes</th></tr></thead>
        <tbody>
          ${logs
            .map(
              (l) => `<tr>
                <td>${formatDateTime(l.created_at)}</td>
                <td>${escapeHtml(l.user_name)}</td>
                <td><strong>${escapeHtml(l.action)}</strong></td>
                <td>${escapeHtml(l.entity)} #${escapeHtml(l.entity_id)}</td>
                <td class="muted">${l.reason ? `<strong>Motivo: ${escapeHtml(l.reason)}</strong> ` : ''}${escapeHtml(l.details)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table></div>
    </div>
  `;

  if (isAdmin) {
    document.getElementById('adm-settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          name: document.getElementById('set-name').value,
          subtitle: document.getElementById('set-sub').value,
          cnpj: document.getElementById('set-cnpj').value,
          phone: document.getElementById('set-phone').value,
          address: document.getElementById('set-addr').value,
        }),
      });
      toast('Configurações salvas!');
    });

    document.getElementById('adm-backup-now').addEventListener('click', async () => {
      await api('/api/admin/backups', { method: 'POST' });
      toast('Backup criado com sucesso!');
      renderAdmin(container);
    });

    document.getElementById('adm-new-user').addEventListener('click', () =>
      openUserModal(null, () => renderAdmin(container))
    );
    document.querySelectorAll('.adm-edit-user').forEach((b) => {
      b.addEventListener('click', () => {
        const u = users.find((x) => x.id === Number(b.dataset.id));
        openUserModal(u, () => renderAdmin(container));
      });
    });
  }
}

function openUserModal(user, onDone) {
  openModal(
    user ? `Editar Usuário — ${user.username}` : 'Novo Usuário',
    `
      <form id="usr-form" class="form-stack">
        <div><label>Nome *</label><input type="text" id="uf-name" required value="${escapeHtml(user?.name || '')}" /></div>
        ${user ? '' : `<div><label>Usuário (login) *</label><input type="text" id="uf-uname" required /></div>`}
        <div>
          <label>Perfil *</label>
          <select id="uf-role">
            <option value="atendente" ${user?.role === 'atendente' ? 'selected' : ''}>Atendente</option>
            <option value="gerente" ${user?.role === 'gerente' ? 'selected' : ''}>Gerente</option>
            <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Administrador</option>
          </select>
        </div>
        ${
          user
            ? `<div><label>Situação</label><select id="uf-active"><option value="1" ${user.active ? 'selected' : ''}>Ativo</option><option value="0" ${!user.active ? 'selected' : ''}>Inativo</option></select></div>`
            : ''
        }
        <div>
          <label>${user ? 'Nova Senha (deixe em branco para manter)' : 'Senha (mín. 4 caracteres) *'}</label>
          <input type="password" id="uf-pass" ${user ? '' : 'required'} />
        </div>
        <button type="submit" class="btn btn-primary btn-lg">Salvar Usuário</button>
      </form>
    `
  );
  document.getElementById('usr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (user) {
        await api(`/api/admin/users/${user.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: document.getElementById('uf-name').value,
            role: document.getElementById('uf-role').value,
            active: document.getElementById('uf-active').value === '1',
            password: document.getElementById('uf-pass').value,
          }),
        });
      } else {
        await api('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({
            name: document.getElementById('uf-name').value,
            username: document.getElementById('uf-uname').value,
            role: document.getElementById('uf-role').value,
            password: document.getElementById('uf-pass').value,
          }),
        });
      }
      toast('Usuário salvo!');
      closeModal();
      await onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function openImportModal({ title, templateUrl, importUrl, onDone }) {
  openModal(
    title,
    `
      <div class="form-stack">
        <div class="alert alert-info">
          Exporte os dados do seu sistema atual para <strong>Excel (.xlsx)</strong> ou <strong>CSV (.csv)</strong>.
          O sistema reconhece automaticamente colunas comuns (ex: Código, Descrição, Unidade, Preço, Nome, CPF/CNPJ, Telefone).
        </div>
        <div>
          <a href="${templateUrl}" class="btn btn-outline">📥 Baixar Planilha Modelo (.xlsx)</a>
        </div>
        <form id="imp-form" class="form-stack">
          <div>
            <label>Selecione o arquivo (.xlsx ou .csv) *</label>
            <input type="file" id="imp-file" accept=".xlsx,.csv,.txt" required />
          </div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="imp-update" checked style="width:18px;height:18px" />
            <span>Atualizar registros já existentes (mesmo código ou CPF/CNPJ/nome)</span>
          </label>
          <div id="imp-result" class="hidden"></div>
          <button type="submit" class="btn btn-primary btn-lg" id="imp-submit">🚀 Iniciar Importação</button>
        </form>
      </div>
    `
  );

  document.getElementById('imp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('imp-file');
    const file = fileInput.files?.[0];
    if (!file) return toast('Selecione um arquivo.', true);

    const btn = document.getElementById('imp-submit');
    btn.disabled = true;
    btn.textContent = 'Importando...';

    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || '');
          resolve(result.includes(',') ? result.split(',')[1] : result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const res = await api(importUrl, {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          contentBase64: base64,
          updateExisting: document.getElementById('imp-update').checked,
        }),
      });

      const resEl = document.getElementById('imp-result');
      resEl.className = 'alert alert-info';
      resEl.innerHTML = `
        <strong>Importação concluída!</strong><br>
        Total lido: <strong>${res.total}</strong> |
        Novos: <strong>${res.created}</strong> |
        Atualizados: <strong>${res.updated}</strong> |
        Ignorados: <strong>${res.skipped}</strong>
        ${res.errors?.length ? `<div style="margin-top:6px;font-size:0.85rem;color:var(--danger)">${res.errors.map(escapeHtml).join('<br>')}</div>` : ''}
      `;
      resEl.classList.remove('hidden');
      toast(`Importação concluída: ${res.created} novos, ${res.updated} atualizados!`);
      await onDone();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '🚀 Iniciar Importação';
    }
  });
}

// Start
checkAuth().catch((err) => {
  console.error(err);
  toast('Erro ao inicializar o sistema.', true);
});
