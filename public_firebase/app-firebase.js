// Construcenter — Versão 100% Firebase (Hosting + Auth + Firestore)
const config = window.FIREBASE_CONFIG;
if (!config || !config.apiKey || config.apiKey === 'COLE_SUA_API_KEY') {
  alert('Configure suas credenciais do Firebase no arquivo public_firebase/firebase-config.js.');
}

firebase.initializeApp(config);
const auth = firebase.auth();
const db = firebase.firestore();

function resolveTenantId() {
  const host = window.location.hostname.toLowerCase();
  const base = (window.BASE_DOMAIN || 'l2sistemas.api.br').toLowerCase();
  if (host.endsWith('.' + base)) {
    return host.slice(0, -(base.length + 1)).replace(/[^a-z0-9-]/g, '') || window.DEFAULT_TENANT;
  }
  return window.DEFAULT_TENANT || 'construcenter';
}

const TENANT_ID = resolveTenantId();
const tRef = db.collection('tenants').doc(TENANT_ID);
const col = (name) => tRef.collection(name);

function toAuthEmail(usernameOrEmail) {
  const clean = String(usernameOrEmail || '').trim().toLowerCase();
  if (clean.includes('@')) return clean;
  return `${clean}@${TENANT_ID}.${window.BASE_DOMAIN || 'l2sistemas.api.br'}`;
}

const state = {
  user: null,
  store: null,
  needsSetup: false,
  currentView: 'dashboard',
  customers: [],
  products: [],
  withdrawalFilters: { customer_id: '', status: '', start_date: '', end_date: '', work_reference: '', q: '' },
  cart: [],
  withdrawalIdem: null,
  closingIdem: null,
};

// Formatters
function formatCents(cents) {
  return (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function formatQty(q) {
  const n = Number(q || 0);
  return n.toLocaleString('pt-BR', { minimumFractionDigits: n % 1 === 0 ? 0 : 1, maximumFractionDigits: 3 });
}
function parseBRCurrency(val) {
  const cleaned = String(val || '0').replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const num = Number(cleaned);
  return Number.isFinite(num) ? Math.max(0, Math.round(num * 100)) : 0;
}
function parseQty(val) {
  const n = Number(String(val || '0').trim().replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
}
function formatDateTime(str) {
  if (!str) return '';
  const clean = String(str).replace('T', ' ');
  const [d, t] = clean.split(' ');
  const parts = (d || '').split('-');
  if (parts.length !== 3) return str;
  return `${parts[2]}/${parts[1]}/${parts[0]}${t ? ' ' + t.slice(0, 5) : ''}`;
}
function formatDate(str) {
  if (!str) return '';
  const d = String(str).replace('T', ' ').split(' ')[0];
  const parts = d.split('-');
  if (parts.length !== 3) return str;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}
function nowLocalISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  return crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function toast(msg, isError = false) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
function openModal(title, html) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = html;
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

async function writeAudit(action, entity, entityId = '', reason = '', details = {}) {
  await col('audit_logs').add({
    user_id: state.user?.uid || '',
    user_name: state.user?.name || 'Sistema',
    action,
    entity,
    entity_id: String(entityId || ''),
    reason: reason || '',
    details: typeof details === 'string' ? details : JSON.stringify(details),
    created_at: nowLocalISO(),
  });
}

function enrichWithdrawal(w) {
  const returns = w.returns || [];
  const returnedByItem = {};
  for (const r of returns) {
    returnedByItem[r.item_idx] = Math.round(((returnedByItem[r.item_idx] || 0) + r.quantity) * 1000) / 1000;
  }
  const items = (w.items || []).map((it, idx) => {
    const returned_qty = returnedByItem[idx] || 0;
    const remaining_qty = Math.max(0, Math.round((it.quantity - returned_qty) * 1000) / 1000);
    return { ...it, idx, returned_qty, remaining_qty };
  });
  const items_subtotal_cents = items.reduce((a, b) => a + b.subtotal_cents, 0);
  const returns_total_cents = returns.reduce((a, b) => a + b.refund_cents, 0);
  const net_total_cents =
    w.status === 'cancelada'
      ? 0
      : Math.max(0, items_subtotal_cents - returns_total_cents - (w.discount_cents || 0));
  return { ...w, items, returns, corrections: w.corrections || [], items_subtotal_cents, returns_total_cents, net_total_cents };
}

// Apply per-tenant logo and title across login, sidebar, mobile header, favicon, and PDFs
function applyTenantBranding(store) {
  const logoSrc = (store && store.logo_data_url) || '/logo.jpeg';
  const brandName = (store && store.name) || TENANT_ID.toUpperCase();
  window.TENANT_LOGO_URL = logoSrc;

  document.querySelectorAll('.auth-logo, .mobile-logo, .sidebar-logo').forEach((img) => {
    img.src = logoSrc;
    img.alt = brandName;
  });

  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = logoSrc;
}

function resizeLogoToDataUrl(file, maxW = 480, maxH = 240) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Falha ao ler o arquivo de imagem.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width, maxH / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Auth state listener
async function refreshSession(fbUser) {
  const cfgSnap = await col('meta').doc('config').get();
  state.needsSetup = !cfgSnap.exists;

  const storeSnap = await col('meta').doc('store_settings').get();
  state.store = storeSnap.exists
    ? storeSnap.data()
    : {
        name: TENANT_ID === 'construcenter' ? 'CONSTRUCENTER' : TENANT_ID.toUpperCase(),
        subtitle: TENANT_ID === 'construcenter' ? 'Materiais para Construção e Elétrica em Geral' : '',
        cnpj: '',
        phone: '',
        address: '',
        logo_data_url: '',
      };
  applyTenantBranding(state.store);

  if (!fbUser || state.needsSetup) {
    state.user = null;
  } else {
    const uSnap = await col('users').doc(fbUser.uid).get();
    if (!uSnap.exists || !uSnap.data().active) {
      state.user = null;
      await auth.signOut();
    } else {
      state.user = { uid: fbUser.uid, ...uSnap.data() };
    }
  }

  const authScreen = document.getElementById('auth-screen');
  const appShell = document.getElementById('app-shell');

  if (!state.user) {
    appShell.classList.add('hidden');
    authScreen.classList.remove('hidden');
    const setupGroup = document.getElementById('setup-name-group');
    const forgotBtn = document.getElementById('forgot-password-btn');
    const title = document.getElementById('auth-title');
    const sub = document.getElementById('auth-subtitle');
    const btn = document.getElementById('auth-submit-btn');

    if (state.needsSetup) {
      setupGroup.classList.remove('hidden');
      forgotBtn.classList.add('hidden');
      title.textContent = 'Configuração Inicial';
      sub.textContent = 'Crie o primeiro usuário Administrador para iniciar o sistema';
      btn.textContent = 'Criar Administrador e Entrar';
    } else {
      setupGroup.classList.add('hidden');
      forgotBtn.classList.remove('hidden');
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

  document.querySelectorAll('.nav-item[data-roles]').forEach((btn) => {
    const allowed = btn.dataset.roles.split(',');
    btn.classList.toggle('hidden', !allowed.includes(state.user.role));
  });

  await navigate('dashboard');
}

auth.onAuthStateChanged((fbUser) => {
  refreshSession(fbUser).catch((err) => toast(err.message, true));
});

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('auth-error');
  errEl.classList.add('hidden');
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const name = document.getElementById('auth-name').value.trim();

  try {
    const email = toAuthEmail(username);
    if (state.needsSetup) {
      if (!name) throw new Error('Informe o nome completo do Administrador.');
      if (password.length < 6) throw new Error('A senha deve ter no mínimo 6 caracteres.');
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      await col('users').doc(cred.user.uid).set({
        name,
        username: username.toLowerCase(),
        email,
        role: 'admin',
        active: true,
        created_at: nowLocalISO(),
      });
      await col('meta').doc('config').set({ initialized: true, created_at: nowLocalISO() });
      await col('meta').doc('store_settings').set({
        name: 'CONSTRUCENTER',
        subtitle: 'Materiais para Construção e Elétrica em Geral',
        cnpj: '',
        phone: '',
        address: '',
      });
      await col('meta').doc('counters').set({ withdrawals: 0, orders: 0 });
      toast('Administrador criado com sucesso!');
      await refreshSession(cred.user);
    } else {
      const cred = await auth.signInWithEmailAndPassword(email, password);
      await refreshSession(cred.user);
    }
    document.getElementById('auth-password').value = '';
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('forgot-password-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('auth-error');
  const infoEl = document.getElementById('auth-info');
  errEl.classList.add('hidden');
  infoEl.classList.add('hidden');
  const input = document.getElementById('auth-username').value.trim();

  if (!input) {
    errEl.textContent = 'Digite seu e-mail no campo acima e clique novamente em "Esqueci minha senha".';
    errEl.classList.remove('hidden');
    return;
  }
  if (!input.includes('@')) {
    errEl.textContent = 'A recuperação por e-mail funciona apenas para contas cadastradas com um e-mail válido. Para usuários simples, peça ao Administrador para redefinir no Console do Firebase.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    await auth.sendPasswordResetEmail(input.toLowerCase());
    infoEl.textContent = `Enviamos um link de redefinição de senha para ${input.toLowerCase()}. Verifique sua caixa de entrada e spam.`;
    infoEl.classList.remove('hidden');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logout-btn').addEventListener('click', () => auth.signOut());

// Mobile sidebar
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
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
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

async function fetchAll(collectionName, orderField = null, desc = false) {
  let q = col(collectionName);
  if (orderField) q = q.orderBy(orderField, desc ? 'desc' : 'asc');
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// 1. DASHBOARD
async function renderDashboard(container) {
  const [rawW, orders] = await Promise.all([
    fetchAll('withdrawals', 'withdrawal_date', true),
    fetchAll('orders', 'issued_at', true),
  ]);
  const withdrawals = rawW.map(enrichWithdrawal);
  const openW = withdrawals.filter((w) => w.status === 'aberta');
  const open_total_cents = openW.reduce((a, w) => a + w.net_total_cents, 0);

  const byCust = new Map();
  for (const w of openW) {
    if (!byCust.has(w.customer_id)) {
      byCust.set(w.customer_id, { customer_id: w.customer_id, customer_name: w.customer_name, customer_phone: w.customer_phone, open_count: 0, open_total_cents: 0 });
    }
    const c = byCust.get(w.customer_id);
    c.open_count += 1;
    c.open_total_cents += w.net_total_cents;
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const monthStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const todayCount = withdrawals.filter((w) => (w.withdrawal_date || '').startsWith(todayStr) && w.status !== 'cancelada').length;
  const monthOrders = orders.filter((o) => (o.issued_at || '').startsWith(monthStr)).length;
  const pendingCustomers = Array.from(byCust.values()).sort((a, b) => b.open_total_cents - a.open_total_cents);
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
      <div class="kpi-card"><div class="kpi-label">Total em Aberto</div><div class="kpi-value">${formatCents(open_total_cents)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Clientes Pendentes</div><div class="kpi-value">${pendingCustomers.length}</div></div>
      <div class="kpi-card"><div class="kpi-label">Retiradas do Dia</div><div class="kpi-value">${todayCount}</div></div>
      <div class="kpi-card"><div class="kpi-label">Pedidos no Mês</div><div class="kpi-value">${monthOrders}</div></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h2 class="card-title">Clientes com Retiradas Pendentes</h2>
        ${pendingCustomers.length === 0 ? '<p class="muted">Nenhum cliente com conta em aberto.</p>' : `<div class="table-wrap"><table><thead><tr><th>Cliente</th><th class="text-center">Retiradas</th><th class="text-right">Saldo Aberto</th><th></th></tr></thead><tbody>${pendingCustomers.map((c) => `<tr><td><strong>${escapeHtml(c.customer_name)}</strong></td><td class="text-center">${c.open_count}</td><td class="text-right"><strong>${formatCents(c.open_total_cents)}</strong></td><td class="text-right"><button class="btn btn-outline btn-sm open-cust-btn" data-id="${c.customer_id}">Ver Conta</button></td></tr>`).join('')}</tbody></table></div>`}
      </div>
      <div class="card">
        <h2 class="card-title">Últimas Retiradas</h2>
        ${withdrawals.length === 0 ? '<p class="muted">Nenhuma retirada registrada.</p>' : `<div class="table-wrap"><table><thead><tr><th>Código</th><th>Cliente</th><th>Data</th><th>Status</th><th class="text-right">Total</th></tr></thead><tbody>${withdrawals.slice(0, 8).map((w) => `<tr><td><strong>${escapeHtml(w.code)}</strong></td><td>${escapeHtml(w.customer_name)}</td><td>${formatDateTime(w.withdrawal_date)}</td><td><span class="badge badge-${w.status}">${w.status}</span></td><td class="text-right">${formatCents(w.net_total_cents)}</td></tr>`).join('')}</tbody></table></div>`}
      </div>
    </div>
  `;
  document.getElementById('dash-new-w').addEventListener('click', () => navigate('new-withdrawal'));
  const cb = document.getElementById('dash-close');
  if (cb) cb.addEventListener('click', () => navigate('closing'));
  container.querySelectorAll('.open-cust-btn').forEach((b) => {
    b.addEventListener('click', () => {
      state.withdrawalFilters.customer_id = b.dataset.id;
      state.withdrawalFilters.status = 'aberta';
      navigate('withdrawals');
    });
  });
}

// 2. NOVA RETIRADA
async function renderNewWithdrawal(container) {
  const [allC, allP] = await Promise.all([fetchAll('customers', 'name'), fetchAll('products', 'description')]);
  state.customers = allC.filter((c) => c.status === 'ativo');
  state.products = allP.filter((p) => p.status === 'ativo');
  state.cart = [];
  state.withdrawalIdem = genKey();
  const canDiscount = ['admin', 'gerente'].includes(state.user.role);

  container.innerHTML = `
    <div class="page-header"><h1>Registrar Nova Retirada</h1></div>
    <div class="grid-2">
      <div class="card">
        <h2 class="card-title">1. Dados da Retirada</h2>
        <div class="form-stack">
          <div><label>Cliente *</label><select id="nw-customer"><option value="">-- Selecione --</option>${state.customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></div>
          <div class="grid-2">
            <div><label>Data e Hora *</label><input type="datetime-local" id="nw-date" value="${nowInputDateTime()}" /></div>
            <div><label>Obra ou Referência</label><input type="text" id="nw-work" placeholder="Ex: Obra Rua A" /></div>
          </div>
          <div><label>Pessoa Autorizada</label><select id="nw-auth-select"><option value="">-- Selecione ou digite abaixo --</option></select></div>
          <div><label>Nome de quem retirou *</label><input type="text" id="nw-picked-by" /></div>
          <div><label>Observações</label><textarea id="nw-notes" rows="2"></textarea></div>
        </div>
      </div>
      <div class="card">
        <h2 class="card-title">2. Buscar e Adicionar Produtos</h2>
        <div class="form-stack">
          <div>
            <label>Buscar por Código, Descrição ou Código de Barras</label>
            <input type="text" id="nw-prod-search" placeholder="Digite código, barras ou nome..." autocomplete="off" />
            <div id="nw-prod-results" class="search-results hidden"></div>
          </div>
        </div>
        <hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />
        <div id="nw-cart-container"></div>
        <div style="margin-top:14px;padding-top:12px;border-top:2px solid var(--border)">
          <div class="grid-2" style="align-items:end">
            <div><label>Desconto (R$) ${canDiscount ? '' : '(Apenas Gerente/Admin)'}</label><input type="text" id="nw-discount" value="0,00" ${canDiscount ? '' : 'disabled'} /></div>
            <div class="text-right"><div class="muted">Total da Retirada</div><div id="nw-total-display" style="font-size:1.7rem;font-weight:800">R$ 0,00</div></div>
          </div>
          <button id="nw-save-btn" class="btn btn-primary btn-lg" style="width:100%;margin-top:14px">✅ Salvar Retirada na Conta Aberta</button>
        </div>
      </div>
    </div>
  `;

  const custSelect = document.getElementById('nw-customer');
  const authSelect = document.getElementById('nw-auth-select');
  const pickedInput = document.getElementById('nw-picked-by');

  custSelect.addEventListener('change', () => {
    const cust = state.customers.find((c) => c.id === custSelect.value);
    authSelect.innerHTML = '<option value="">-- Selecione ou digite abaixo --</option>';
    if (cust) {
      const optS = document.createElement('option');
      optS.value = cust.name;
      optS.textContent = `${cust.name} (Próprio cliente)`;
      authSelect.appendChild(optS);
      for (const p of cust.authorized_people || []) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = `${p.name}${p.identification ? ` (${p.identification})` : ''}`;
        authSelect.appendChild(opt);
      }
    }
  });
  authSelect.addEventListener('change', () => {
    if (authSelect.value) pickedInput.value = authSelect.value;
  });

  const searchInput = document.getElementById('nw-prod-search');
  const resultsBox = document.getElementById('nw-prod-results');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) return resultsBox.classList.add('hidden');
    const matches = state.products.filter((p) => p.internal_code.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q) || p.description.toLowerCase().includes(q)).slice(0, 15);
    resultsBox.innerHTML = matches.length === 0 ? '<div class="search-result-item muted">Nenhum produto encontrado.</div>' : matches.map((p) => `<div class="search-result-item" data-id="${p.id}"><div><strong>${escapeHtml(p.internal_code)}</strong> — ${escapeHtml(p.description)} <div class="muted">Unid: ${escapeHtml(p.unit)}</div></div><strong>${formatCents(p.price_cents)}</strong></div>`).join('');
    resultsBox.classList.remove('hidden');
    resultsBox.querySelectorAll('.search-result-item[data-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const prod = state.products.find((p) => p.id === el.dataset.id);
        if (prod) {
          state.cart.push({ product_id: prod.id, product_code: prod.internal_code, product_description: prod.description, product_unit: prod.unit, quantity: 1, unit_price_cents: prod.price_cents });
          searchInput.value = '';
          resultsBox.classList.add('hidden');
          renderCart();
        }
      });
    });
  });

  function renderCart() {
    const el = document.getElementById('nw-cart-container');
    if (state.cart.length === 0) {
      el.innerHTML = '<p class="muted">Nenhum produto adicionado.</p>';
      updateTotal();
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Produto</th><th style="width:90px">Qtd</th><th style="width:105px">V. Unit</th><th class="text-right">Subtotal</th><th></th></tr></thead><tbody>${state.cart.map((it, idx) => `<tr><td><strong>${escapeHtml(it.product_code)}</strong><br>${escapeHtml(it.product_description)}</td><td><input type="text" class="cq" data-idx="${idx}" value="${String(it.quantity).replace('.', ',')}" /></td><td><input type="text" class="cp" data-idx="${idx}" value="${(it.unit_price_cents / 100).toFixed(2).replace('.', ',')}" /></td><td class="text-right"><strong>${formatCents(Math.round(it.quantity * it.unit_price_cents))}</strong></td><td><button class="btn btn-outline btn-sm cr" data-idx="${idx}">✕</button></td></tr>`).join('')}</tbody></table></div>`;
    el.querySelectorAll('.cq').forEach((inp) => inp.addEventListener('change', () => { const q = parseQty(inp.value); if (q > 0) state.cart[Number(inp.dataset.idx)].quantity = q; renderCart(); }));
    el.querySelectorAll('.cp').forEach((inp) => inp.addEventListener('change', () => { state.cart[Number(inp.dataset.idx)].unit_price_cents = parseBRCurrency(inp.value); renderCart(); }));
    el.querySelectorAll('.cr').forEach((btn) => btn.addEventListener('click', () => { state.cart.splice(Number(btn.dataset.idx), 1); renderCart(); }));
    updateTotal();
  }
  function updateTotal() {
    const sub = state.cart.reduce((a, it) => a + Math.round(it.quantity * it.unit_price_cents), 0);
    const disc = parseBRCurrency(document.getElementById('nw-discount').value);
    document.getElementById('nw-total-display').textContent = formatCents(Math.max(0, sub - disc));
  }
  document.getElementById('nw-discount').addEventListener('input', updateTotal);
  renderCart();

  document.getElementById('nw-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('nw-save-btn');
    const customer = state.customers.find((c) => c.id === custSelect.value);
    const picked = pickedInput.value.trim();
    const rawDate = document.getElementById('nw-date').value;
    if (!customer) return toast('Selecione um cliente.', true);
    if (!rawDate) return toast('Informe a data e hora da retirada.', true);
    if (!picked) return toast('Informe quem retirou.', true);
    if (state.cart.length === 0) return toast('Adicione pelo menos um produto.', true);
    btn.disabled = true;
    try {
      const created = await db.runTransaction(async (tx) => {
        const wDocRef = col('withdrawals').doc(state.withdrawalIdem);
        const existing = await tx.get(wDocRef);
        if (existing.exists) return enrichWithdrawal({ id: existing.id, ...existing.data() });

        const cntRef = col('meta').doc('counters');
        const cntSnap = await tx.get(cntRef);
        const nextNum = ((cntSnap.data()?.withdrawals) || 0) + 1;
        const dateStr = rawDate.replace('T', ' ') + ':00';
        const year = dateStr.slice(0, 4) || String(new Date().getFullYear());
        const code = `RET-${year}-${String(nextNum).padStart(4, '0')}`;

        const payload = {
          code,
          customer_id: customer.id,
          customer_name: customer.name,
          customer_document: customer.document || '',
          customer_phone: customer.phone || '',
          withdrawal_date: dateStr,
          picked_up_by: picked,
          employee_id: state.user.uid,
          employee_name: state.user.name,
          work_reference: document.getElementById('nw-work').value.trim(),
          discount_cents: parseBRCurrency(document.getElementById('nw-discount').value),
          notes: document.getElementById('nw-notes').value.trim(),
          status: 'aberta',
          order_id: '',
          order_number: '',
          items: state.cart.map((it) => ({ ...it, subtotal_cents: Math.round(it.quantity * it.unit_price_cents) })),
          returns: [],
          corrections: [],
          created_at: nowLocalISO(),
        };
        tx.set(cntRef, { withdrawals: nextNum }, { merge: true });
        tx.set(wDocRef, payload);
        return enrichWithdrawal({ id: wDocRef.id, ...payload });
      });
      await writeAudit('CREATE', 'withdrawals', created.id, '', { code: created.code, customer: created.customer_name });
      toast(`Retirada ${created.code} salva!`);
      openModal(`Retirada ${created.code} Registrada`, `<p>Total: <strong>${formatCents(created.net_total_cents)}</strong></p><div class="btn-group" style="margin-top:14px"><button class="btn btn-primary btn-lg" id="m-pdf">🖨️ Imprimir / PDF Comprovante</button><button class="btn btn-outline btn-lg" id="m-new">Nova Retirada</button></div>`);
      document.getElementById('m-pdf').addEventListener('click', () => window.exportWithdrawalReceiptPDF(created, state.store));
      document.getElementById('m-new').addEventListener('click', () => { closeModal(); renderNewWithdrawal(container); });
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
}

// 3. CONTA ABERTA / RETIRADAS
async function renderWithdrawals(container) {
  const customers = await fetchAll('customers', 'name');
  const f = state.withdrawalFilters;
  container.innerHTML = `
    <div class="page-header"><h1>Conta Aberta & Retiradas</h1><button class="btn btn-primary" id="w-new-btn">➕ Nova Retirada</button></div>
    <div class="card">
      <div class="grid-4">
        <div><label>Cliente</label><select id="wf-customer"><option value="">Todos</option>${customers.map((c) => `<option value="${c.id}" ${f.customer_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
        <div><label>Situação</label><select id="wf-status"><option value="">Todas</option><option value="aberta" ${f.status === 'aberta' ? 'selected' : ''}>Aberta</option><option value="fechada" ${f.status === 'fechada' ? 'selected' : ''}>Fechada</option><option value="cancelada" ${f.status === 'cancelada' ? 'selected' : ''}>Cancelada</option></select></div>
        <div><label>Data Inicial</label><input type="date" id="wf-start" value="${escapeHtml(f.start_date)}" /></div>
        <div><label>Data Final</label><input type="date" id="wf-end" value="${escapeHtml(f.end_date)}" /></div>
      </div>
      <div class="grid-3" style="margin-top:10px;align-items:end">
        <div><label>Obra</label><input type="text" id="wf-work" value="${escapeHtml(f.work_reference)}" /></div>
        <div><label>Pesquisa</label><input type="text" id="wf-q" value="${escapeHtml(f.q)}" /></div>
        <div class="btn-group"><button class="btn btn-dark" id="wf-apply">🔍 Filtrar</button><button class="btn btn-outline" id="wf-clear">Limpar</button></div>
      </div>
    </div>
    <div id="w-summary-bar" class="card" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px"></div>
    <div id="w-list"></div>
  `;
  document.getElementById('w-new-btn').addEventListener('click', () => navigate('new-withdrawal'));

  async function loadList() {
    const raw = await fetchAll('withdrawals', 'withdrawal_date', true);
    const list = raw.map(enrichWithdrawal).filter((w) => {
      if (f.customer_id && w.customer_id !== f.customer_id) return false;
      if (f.status && w.status !== f.status) return false;
      if (f.start_date && (w.withdrawal_date || '').slice(0, 10) < f.start_date) return false;
      if (f.end_date && (w.withdrawal_date || '').slice(0, 10) > f.end_date) return false;
      if (f.work_reference && !(w.work_reference || '').toLowerCase().includes(f.work_reference.toLowerCase())) return false;
      if (f.q && !`${w.code} ${w.customer_name} ${w.picked_up_by} ${w.work_reference}`.toLowerCase().includes(f.q.toLowerCase())) return false;
      return true;
    });
    const openTotal = list.filter((w) => w.status === 'aberta').reduce((a, w) => a + w.net_total_cents, 0);
    const isManager = ['admin', 'gerente'].includes(state.user.role);
    document.getElementById('w-summary-bar').innerHTML = `<div><strong>${list.length}</strong> retirada(s)</div><div>Total Pendente: <strong style="color:var(--brand-orange-dark)">${formatCents(openTotal)}</strong></div>`;
    const listEl = document.getElementById('w-list');
    listEl.innerHTML = list.length === 0 ? '<div class="card muted">Nenhuma retirada encontrada.</div>' : list.map((w) => `
      <div class="withdrawal-card">
        <div class="withdrawal-card-header">
          <div>
            <strong>${escapeHtml(w.code)}</strong> <span class="badge badge-${w.status}">${w.status}</span>
            ${w.order_number ? `<span class="badge badge-neutral">Pedido: ${escapeHtml(w.order_number)}</span>` : ''}
            <div class="muted">Cliente: <strong>${escapeHtml(w.customer_name)}</strong> • ${formatDateTime(w.withdrawal_date)} • Retirado por: ${escapeHtml(w.picked_up_by)} ${w.work_reference ? `• Obra: ${escapeHtml(w.work_reference)}` : ''}</div>
          </div>
          <div class="text-right"><strong>${formatCents(w.net_total_cents)}</strong></div>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Código</th><th>Produto</th><th>Unid.</th><th class="text-right">Qtd.</th><th class="text-right">V. Unit</th><th class="text-right">Subtotal</th></tr></thead><tbody>${w.items.map((it) => `<tr><td>${escapeHtml(it.product_code)}</td><td>${escapeHtml(it.product_description)}</td><td>${escapeHtml(it.product_unit)}</td><td class="text-right">${formatQty(it.quantity)}${it.returned_qty > 0 ? ` (-${formatQty(it.returned_qty)} dev.)` : ''}</td><td class="text-right">${formatCents(it.unit_price_cents)}</td><td class="text-right">${formatCents(it.subtotal_cents)}</td></tr>`).join('')}</tbody></table></div>
        ${w.returns.length ? `<div class="alert alert-warning" style="margin-top:8px"><strong>Devoluções:</strong> ${w.returns.map((r) => `${escapeHtml(r.product_description)}: ${formatQty(r.quantity)} (${escapeHtml(r.reason)})`).join(' | ')}</div>` : ''}
        ${w.corrections.length ? `<div class="alert alert-info" style="margin-top:8px"><strong>Correções:</strong> ${w.corrections.map((c) => `${escapeHtml(c.user_name)}: ${escapeHtml(c.reason)}`).join(' | ')}</div>` : ''}
        <div class="btn-group" style="margin-top:10px">
          <button class="btn btn-outline btn-sm w-pdf" data-id="${w.id}">🖨️ Comprovante PDF</button>
          ${w.status === 'aberta' ? `<button class="btn btn-outline btn-sm w-ret" data-id="${w.id}">↩️ Devolução</button>` : ''}
          ${w.status === 'aberta' && isManager ? `<button class="btn btn-danger btn-sm w-can" data-id="${w.id}">Cancelar</button>` : ''}
          ${w.status === 'fechada' && isManager ? `<button class="btn btn-dark btn-sm w-cor" data-id="${w.id}">✏️ Correção Pós-Fechamento</button>` : ''}
        </div>
      </div>
    `).join('');

    listEl.querySelectorAll('.w-pdf').forEach((b) => b.addEventListener('click', () => window.exportWithdrawalReceiptPDF(list.find((x) => x.id === b.dataset.id), state.store)));
    listEl.querySelectorAll('.w-ret').forEach((b) => b.addEventListener('click', () => openReturnModal(list.find((x) => x.id === b.dataset.id), loadList)));
    listEl.querySelectorAll('.w-can').forEach((b) => b.addEventListener('click', () => openCancelModal(list.find((x) => x.id === b.dataset.id), loadList)));
    listEl.querySelectorAll('.w-cor').forEach((b) => b.addEventListener('click', () => openCorrectionModal(list.find((x) => x.id === b.dataset.id), loadList)));
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
  const avail = w.items.filter((it) => it.remaining_qty > 0);
  if (!avail.length) return toast('Sem itens disponíveis para devolução.', true);
  openModal(`Devolução — ${w.code}`, `<form id="rf" class="form-stack"><div><label>Item *</label><select id="ri">${avail.map((it) => `<option value="${it.idx}">${escapeHtml(it.product_description)} (Disp: ${formatQty(it.remaining_qty)})</option>`).join('')}</select></div><div><label>Quantidade *</label><input type="text" id="rq" required value="1" /></div><div><label>Motivo *</label><input type="text" id="rr" required /></div><button type="submit" class="btn btn-primary btn-lg">Confirmar Devolução</button></form>`);
  document.getElementById('rf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const idx = Number(document.getElementById('ri').value);
    const qty = parseQty(document.getElementById('rq').value);
    const reason = document.getElementById('rr').value.trim();
    if (!qty || qty <= 0) return toast('Quantidade inválida.', true);
    if (!reason) return toast('Informe o motivo da devolução.', true);
    try {
      await db.runTransaction(async (tx) => {
        const wRef = col('withdrawals').doc(w.id);
        const wSnap = await tx.get(wRef);
        if (!wSnap.exists) throw new Error('Retirada não encontrada.');
        const current = enrichWithdrawal({ id: wSnap.id, ...wSnap.data() });
        if (current.status !== 'aberta') {
          throw new Error('Devoluções diretas só podem ser registradas em retiradas abertas.');
        }
        const item = current.items.find((x) => x.idx === idx);
        if (!item || qty > item.remaining_qty + 0.0001) {
          throw new Error('Quantidade devolvida excede o saldo disponível do item.');
        }
        const retEntry = {
          item_idx: idx,
          product_description: item.product_description,
          quantity: qty,
          refund_cents: Math.round(qty * item.unit_price_cents),
          reason,
          returned_at: nowLocalISO(),
        };
        tx.update(wRef, { returns: firebase.firestore.FieldValue.arrayUnion(retEntry) });
      });
      await writeAudit('RETURN_ITEM', 'withdrawals', w.id, reason, { item_idx: idx, quantity: qty });
      toast('Devolução registrada!');
      closeModal();
      await onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function openCancelModal(w, onDone) {
  openModal(`Cancelar ${w.code}`, `<form id="cf" class="form-stack"><div><label>Motivo *</label><input type="text" id="cr" required /></div><button type="submit" class="btn btn-danger btn-lg">Confirmar Cancelamento</button></form>`);
  document.getElementById('cf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const reason = document.getElementById('cr').value.trim();
    await col('withdrawals').doc(w.id).update({ status: 'cancelada', cancel_reason: reason });
    await writeAudit('CANCEL', 'withdrawals', w.id, reason, { code: w.code });
    toast('Retirada cancelada.');
    closeModal();
    await onDone();
  });
}

function openCorrectionModal(w, onDone) {
  openModal(`Correção Pós-Fechamento — ${w.code}`, `<form id="cof" class="form-stack"><div class="alert alert-warning">Dados anteriores preservados no histórico.</div><div><label>Motivo *</label><input type="text" id="cor-r" required /></div><div><label>Retirado por</label><input type="text" id="cor-p" value="${escapeHtml(w.picked_up_by)}" /></div><div><label>Obra</label><input type="text" id="cor-w" value="${escapeHtml(w.work_reference || '')}" /></div><div><label>Desconto (R$)</label><input type="text" id="cor-d" value="${((w.discount_cents || 0) / 100).toFixed(2).replace('.', ',')}" /></div><button type="submit" class="btn btn-dark btn-lg">Salvar Correção</button></form>`);
  document.getElementById('cof').addEventListener('submit', async (e) => {
    e.preventDefault();
    const reason = document.getElementById('cor-r').value.trim();
    if (!reason) return toast('O motivo da correção é obrigatório.', true);
    const newPicked = document.getElementById('cor-p').value.trim();
    const newWork = document.getElementById('cor-w').value.trim();
    const newDisc = parseBRCurrency(document.getElementById('cor-d').value);
    const corr = { user_name: state.user.name, reason, previous_picked_up_by: w.picked_up_by, previous_work: w.work_reference, previous_discount_cents: w.discount_cents || 0, created_at: nowLocalISO() };
    try {
      await db.runTransaction(async (tx) => {
        const wRef = col('withdrawals').doc(w.id);
        const wSnap = await tx.get(wRef);
        if (!wSnap.exists) throw new Error('Retirada não encontrada.');
        const curW = wSnap.data();

        let orderSnap = null;
        const oRef = curW.order_id ? col('orders').doc(curW.order_id) : null;
        if (oRef) {
          orderSnap = await tx.get(oRef);
        }

        tx.update(wRef, {
          picked_up_by: newPicked,
          work_reference: newWork,
          discount_cents: newDisc,
          corrections: firebase.firestore.FieldValue.arrayUnion(corr),
        });

        if (oRef && orderSnap && orderSnap.exists) {
          const ord = orderSnap.data();
          const discDiff = newDisc - (curW.discount_cents || 0);
          const newOrderDisc = Math.max(0, (ord.discount_cents || 0) + discDiff);
          const newOrderTotal = Math.max(0, (ord.subtotal_cents || 0) - (ord.returns_cents || 0) - newOrderDisc);
          const updatedWithdrawals = (ord.withdrawals || []).map((ow) =>
            ow.id === w.id
              ? enrichWithdrawal({ ...ow, picked_up_by: newPicked, work_reference: newWork, discount_cents: newDisc })
              : ow
          );
          tx.update(oRef, {
            discount_cents: newOrderDisc,
            total_cents: newOrderTotal,
            withdrawals: updatedWithdrawals,
          });
        }
      });
      await writeAudit('POST_CLOSE_CORRECTION', 'withdrawals', w.id, reason, corr);
      toast('Correção registrada!');
      closeModal();
      await onDone();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// 4. FECHAMENTO E PEDIDOS
function buildConsolidated(withdrawals) {
  const map = new Map();
  for (const w of withdrawals) {
    for (const it of w.items || []) {
      const key = `${it.product_code}::${it.product_unit}::${it.unit_price_cents}`;
      if (!map.has(key)) map.set(key, { product_code: it.product_code, product_description: it.product_description, product_unit: it.product_unit, unit_price_cents: it.unit_price_cents, quantity: 0, subtotal_cents: 0 });
      const e = map.get(key);
      e.quantity = Math.round((e.quantity + it.quantity) * 1000) / 1000;
      e.subtotal_cents += it.subtotal_cents;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.product_description.localeCompare(b.product_description, 'pt-BR'));
}

async function renderClosingAndOrders(container, ordersOnly = false) {
  const [customers, orders] = await Promise.all([fetchAll('customers', 'name'), fetchAll('orders', 'issued_at', true)]);
  container.innerHTML = `
    <div class="page-header"><h1>${ordersOnly ? 'Pedidos Gerados' : 'Fechamento de Conta e Pedidos'}</h1></div>
    ${ordersOnly ? '' : `<div class="card"><h2 class="card-title">Fechar Retiradas e Gerar Pedido</h2><div class="grid-4" style="align-items:end"><div><label>Cliente *</label><select id="cl-cust"><option value="">-- Selecione --</option>${customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></div><div><label>Data Inicial</label><input type="date" id="cl-s" /></div><div><label>Data Final</label><input type="date" id="cl-e" /></div><button class="btn btn-dark btn-lg" id="cl-go">🔍 Buscar Retiradas Abertas</button></div><div id="cl-preview" style="margin-top:16px"></div></div>`}
    <div class="card"><h2 class="card-title">Pedidos Gerados</h2>${orders.length === 0 ? '<p class="muted">Nenhum pedido gerado.</p>' : `<div class="table-wrap"><table><thead><tr><th>Nº Pedido</th><th>Emissão</th><th>Cliente</th><th>Período</th><th class="text-right">Total</th><th></th></tr></thead><tbody>${orders.map((o) => `<tr><td><strong>${escapeHtml(o.order_number)}</strong></td><td>${formatDateTime(o.issued_at)}</td><td>${escapeHtml(o.customer?.name || '')}</td><td>${formatDate(o.period_start)} a ${formatDate(o.period_end)}</td><td class="text-right"><strong>${formatCents(o.total_cents)}</strong></td><td class="text-right"><button class="btn btn-outline btn-sm vo" data-id="${o.id}">Visualizar / PDF</button></td></tr>`).join('')}</tbody></table></div>`}</div>
  `;
  container.querySelectorAll('.vo').forEach((b) => b.addEventListener('click', () => openOrderModal(orders.find((x) => x.id === b.dataset.id))));
  if (!ordersOnly) {
    document.getElementById('cl-go').addEventListener('click', () => loadClosingPreview(container, customers));
  }
}

async function loadClosingPreview(container, customers, selectedIds = null) {
  const cid = document.getElementById('cl-cust').value;
  const ps = document.getElementById('cl-s').value;
  const pe = document.getElementById('cl-e').value;
  if (!cid) return toast('Selecione um cliente.', true);
  state.closingIdem = genKey();
  const customer = customers.find((c) => c.id === cid);
  const allW = (await fetchAll('withdrawals', 'withdrawal_date', false)).map(enrichWithdrawal);
  const avail = allW.filter((w) => w.customer_id === cid && w.status === 'aberta' && (!ps || w.withdrawal_date.slice(0, 10) >= ps) && (!pe || w.withdrawal_date.slice(0, 10) <= pe));
  const area = document.getElementById('cl-preview');
  if (!avail.length) {
    area.innerHTML = '<div class="alert alert-info">Nenhuma retirada aberta neste período.</div>';
    return;
  }
  const sel = selectedIds ? avail.filter((w) => selectedIds.includes(w.id)) : avail;
  const selSet = new Set(sel.map((w) => w.id));
  const cons = buildConsolidated(sel);
  const sub = sel.reduce((a, w) => a + w.items_subtotal_cents, 0);
  const ret = sel.reduce((a, w) => a + w.returns_total_cents, 0);
  const disc = sel.reduce((a, w) => a + (w.discount_cents || 0), 0);
  const tot = Math.max(0, sub - ret - disc);

  area.innerHTML = `
    <div class="table-wrap" style="margin-bottom:12px"><table><thead><tr><th>Inc.</th><th>Código</th><th>Data</th><th>Obra</th><th class="text-right">Líquido</th></tr></thead><tbody>${avail.map((w) => `<tr><td><input type="checkbox" class="cl-chk" value="${w.id}" ${selSet.has(w.id) ? 'checked' : ''} style="width:20px;height:20px" /></td><td><strong>${escapeHtml(w.code)}</strong></td><td>${formatDateTime(w.withdrawal_date)}</td><td>${escapeHtml(w.work_reference || '-')}</td><td class="text-right">${formatCents(w.net_total_cents)}</td></tr>`).join('')}</tbody></table></div>
    <div class="table-wrap" style="margin-bottom:12px"><table><thead><tr><th>Código</th><th>Produto</th><th>Unid.</th><th class="text-right">Qtd.</th><th class="text-right">V. Unit</th><th class="text-right">Total</th></tr></thead><tbody>${cons.map((it) => `<tr><td>${escapeHtml(it.product_code)}</td><td>${escapeHtml(it.product_description)}</td><td>${escapeHtml(it.product_unit)}</td><td class="text-right">${formatQty(it.quantity)}</td><td class="text-right">${formatCents(it.unit_price_cents)}</td><td class="text-right">${formatCents(it.subtotal_cents)}</td></tr>`).join('')}</tbody></table></div>
    <div class="grid-3" style="margin-bottom:12px"><div><label>Cond. Pagamento</label><input type="text" id="cl-pay" /></div><div><label>Vencimento</label><input type="date" id="cl-due" /></div><div><label>Desconto Extra (R$)</label><input type="text" id="cl-ed" value="0,00" /></div></div>
    <div style="margin-bottom:12px"><label>Observações</label><input type="text" id="cl-obs" /></div>
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><div><strong>Total do Pedido: ${formatCents(tot)}</strong></div><button class="btn btn-success btn-lg" id="cl-confirm">✅ Confirmar Fechamento e Gerar Pedido</button></div>
  `;
  area.querySelectorAll('.cl-chk').forEach((chk) => chk.addEventListener('change', () => {
    const checked = Array.from(area.querySelectorAll('.cl-chk:checked')).map((c) => c.value);
    if (!checked.length) { chk.checked = true; return; }
    loadClosingPreview(container, customers, checked);
  }));
  document.getElementById('cl-confirm').addEventListener('click', async () => {
    const btn = document.getElementById('cl-confirm');
    const checked = Array.from(area.querySelectorAll('.cl-chk:checked')).map((c) => c.value);
    btn.disabled = true;
    try {
      const orderData = await db.runTransaction(async (tx) => {
        const oRef = col('orders').doc(state.closingIdem);
        const existingO = await tx.get(oRef);
        if (existingO.exists) return { id: existingO.id, ...existingO.data() };

        const wSnaps = await Promise.all(checked.map((id) => tx.get(col('withdrawals').doc(id))));
        const lockedW = wSnaps.map((s) => {
          if (!s.exists || s.data().status !== 'aberta') throw new Error(`Retirada ${s.data()?.code || s.id} já foi fechada!`);
          return enrichWithdrawal({ id: s.id, ...s.data() });
        });

        const cntRef = col('meta').doc('counters');
        const cntSnap = await tx.get(cntRef);
        const nextOrd = ((cntSnap.data()?.orders) || 0) + 1;
        const orderNumber = `PED-${new Date().getFullYear()}-${String(nextOrd).padStart(4, '0')}`;
        const extraDisc = parseBRCurrency(document.getElementById('cl-ed').value);
        const oSub = lockedW.reduce((a, w) => a + w.items_subtotal_cents, 0);
        const oRet = lockedW.reduce((a, w) => a + w.returns_total_cents, 0);
        const oDisc = lockedW.reduce((a, w) => a + (w.discount_cents || 0), 0) + extraDisc;
        const oTot = Math.max(0, oSub - oRet - oDisc);

        const payload = {
          order_number: orderNumber,
          customer_id: customer.id,
          customer,
          period_start: ps || lockedW[0].withdrawal_date.slice(0, 10),
          period_end: pe || lockedW[lockedW.length - 1].withdrawal_date.slice(0, 10),
          issued_at: nowLocalISO(),
          payment_condition: document.getElementById('cl-pay').value.trim(),
          due_date: document.getElementById('cl-due').value,
          notes: document.getElementById('cl-obs').value.trim(),
          subtotal_cents: oSub,
          returns_cents: oRet,
          discount_cents: oDisc,
          total_cents: oTot,
          withdrawals: lockedW,
          consolidated_items: buildConsolidated(lockedW),
        };
        tx.set(cntRef, { orders: nextOrd }, { merge: true });
        tx.set(oRef, payload);
        for (const w of lockedW) {
          tx.update(col('withdrawals').doc(w.id), { status: 'fechada', order_id: oRef.id, order_number: orderNumber });
        }
        return { id: oRef.id, ...payload };
      });
      await writeAudit('CREATE_ORDER', 'orders', orderData.id, '', { order_number: orderData.order_number, total_cents: orderData.total_cents });
      toast(`Pedido ${orderData.order_number} gerado!`);
      await renderClosingAndOrders(container, false);
      openOrderModal(orderData);
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
}

function openOrderModal(o) {
  openModal(`Pedido ${o.order_number}`, `
    <div class="alert alert-warning" style="text-align:center;font-weight:700;margin-bottom:10px">PEDIDO — SEM VALOR FISCAL</div>
    <p><strong>Cliente:</strong> ${escapeHtml(o.customer.name)}<br><strong>Período:</strong> ${formatDate(o.period_start)} a ${formatDate(o.period_end)} | <strong>Total:</strong> ${formatCents(o.total_cents)}</p>
    <div class="tabs"><button class="tab-btn active" id="otc">Resumo Consolidado</button><button class="tab-btn" id="otd">Detalhamento por Data</button></div>
    <div id="ovc"><div class="table-wrap"><table><thead><tr><th>Código</th><th>Produto</th><th>Unid.</th><th class="text-right">Qtd.</th><th class="text-right">V. Unit</th><th class="text-right">Total</th></tr></thead><tbody>${o.consolidated_items.map((it) => `<tr><td>${escapeHtml(it.product_code)}</td><td>${escapeHtml(it.product_description)}</td><td>${escapeHtml(it.product_unit)}</td><td class="text-right">${formatQty(it.quantity)}</td><td class="text-right">${formatCents(it.unit_price_cents)}</td><td class="text-right">${formatCents(it.subtotal_cents)}</td></tr>`).join('')}</tbody></table></div></div>
    <div id="ovd" class="hidden">${o.withdrawals.map((w) => `<div style="margin-bottom:10px"><strong>${escapeHtml(w.code)}</strong> — ${formatDateTime(w.withdrawal_date)} (${escapeHtml(w.picked_up_by)})</div>`).join('')}</div>
    <div class="btn-group" style="margin-top:14px">
      <button class="btn btn-primary" id="opdf-c">📄 PDF Consolidado</button>
      <button class="btn btn-dark" id="opdf-d">📄 PDF Detalhado</button>
      <button class="btn btn-outline" id="opdf-b">📄 PDF Completo</button>
    </div>
  `);
  document.getElementById('otc').addEventListener('click', () => { document.getElementById('ovc').classList.remove('hidden'); document.getElementById('ovd').classList.add('hidden'); });
  document.getElementById('otd').addEventListener('click', () => { document.getElementById('ovd').classList.remove('hidden'); document.getElementById('ovc').classList.add('hidden'); });
  document.getElementById('opdf-c').addEventListener('click', () => window.exportOrderPDF(o, state.store, 'consolidated'));
  document.getElementById('opdf-d').addEventListener('click', () => window.exportOrderPDF(o, state.store, 'detailed'));
  document.getElementById('opdf-b').addEventListener('click', () => window.exportOrderPDF(o, state.store, 'both'));
}

// 5. CLIENTES (com Pessoas Autorizadas + Importação)
async function renderCustomers(container) {
  const customers = await fetchAll('customers', 'name');
  container.innerHTML = `
    <div class="page-header"><h1>Cadastro de Clientes</h1><div class="btn-group"><button class="btn btn-outline btn-lg" id="ci-btn">📥 Importar Planilha</button><button class="btn btn-primary btn-lg" id="cn-btn">➕ Novo Cliente</button></div></div>
    <div class="card"><input type="text" id="cs" placeholder="Pesquisar..." /></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Nome</th><th>CPF/CNPJ</th><th>Telefone</th><th>Autorizados</th><th>Situação</th><th></th></tr></thead><tbody id="ctb"></tbody></table></div></div>
  `;
  function draw(q = '') {
    const t = q.toLowerCase();
    const list = t ? customers.filter((c) => `${c.name} ${c.document} ${c.phone}`.toLowerCase().includes(t)) : customers;
    document.getElementById('ctb').innerHTML = list.map((c) => `<tr><td><strong>${escapeHtml(c.name)}</strong></td><td>${escapeHtml(c.document || '-')}</td><td>${escapeHtml(c.phone || '-')}</td><td>${(c.authorized_people || []).length}</td><td><span class="badge badge-${c.status}">${c.status}</span></td><td class="text-right"><div class="btn-group" style="justify-content:flex-end"><button class="btn btn-outline btn-sm ca" data-id="${c.id}">Autorizados</button><button class="btn btn-dark btn-sm ce" data-id="${c.id}">Editar</button></div></td></tr>`).join('');
    document.querySelectorAll('.ce').forEach((b) => b.addEventListener('click', () => openCustomerModal(customers.find((x) => x.id === b.dataset.id), () => renderCustomers(container))));
    document.querySelectorAll('.ca').forEach((b) => b.addEventListener('click', () => openAuthorizedModal(customers.find((x) => x.id === b.dataset.id), () => renderCustomers(container))));
  }
  document.getElementById('cs').addEventListener('input', (e) => draw(e.target.value));
  document.getElementById('cn-btn').addEventListener('click', () => openCustomerModal(null, () => renderCustomers(container)));
  document.getElementById('ci-btn').addEventListener('click', () => openSpreadsheetImportModal('customers', customers, () => renderCustomers(container)));
  draw();
}

function openCustomerModal(c, onDone) {
  openModal(c ? `Editar ${c.name}` : 'Novo Cliente', `<form id="cf" class="form-stack"><div><label>Nome *</label><input type="text" id="cn" required value="${escapeHtml(c?.name || '')}" /></div><div class="grid-2"><div><label>CPF/CNPJ</label><input type="text" id="cd" value="${escapeHtml(c?.document || '')}" /></div><div><label>Telefone</label><input type="text" id="cp" value="${escapeHtml(c?.phone || '')}" /></div></div><div><label>Endereço</label><input type="text" id="ca" value="${escapeHtml(c?.address || '')}" /></div><div><label>Situação</label><select id="cs"><option value="ativo" ${c?.status !== 'inativo' ? 'selected' : ''}>Ativo</option><option value="inativo" ${c?.status === 'inativo' ? 'selected' : ''}>Inativo</option></select></div><div><label>Observações</label><textarea id="co" rows="2">${escapeHtml(c?.notes || '')}</textarea></div><button type="submit" class="btn btn-primary btn-lg">Salvar</button></form>`);
  document.getElementById('cf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = { name: document.getElementById('cn').value.trim(), document: document.getElementById('cd').value.trim(), phone: document.getElementById('cp').value.trim(), address: document.getElementById('ca').value.trim(), status: document.getElementById('cs').value, notes: document.getElementById('co').value.trim() };
    if (c) await col('customers').doc(c.id).update(payload);
    else await col('customers').add({ ...payload, authorized_people: [], created_at: nowLocalISO() });
    toast('Cliente salvo!');
    closeModal();
    await onDone();
  });
}

function openAuthorizedModal(c, onDone) {
  const people = c.authorized_people || [];
  openModal(`Pessoas Autorizadas — ${c.name}`, `<form id="apf" class="grid-3" style="align-items:end;margin-bottom:14px"><div><label>Nome *</label><input type="text" id="apn" required /></div><div><label>Identificação</label><input type="text" id="api" /></div><button type="submit" class="btn btn-primary">Adicionar</button></form><table><thead><tr><th>Nome</th><th>Identificação</th><th></th></tr></thead><tbody>${people.map((p, i) => `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.identification || '-')}</td><td class="text-right"><button class="btn btn-danger btn-sm apr" data-i="${i}">Remover</button></td></tr>`).join('')}</tbody></table>`);
  document.getElementById('apf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = [...people, { name: document.getElementById('apn').value.trim(), identification: document.getElementById('api').value.trim() }];
    await col('customers').doc(c.id).update({ authorized_people: next });
    c.authorized_people = next;
    openAuthorizedModal(c, onDone);
    onDone();
  });
  document.querySelectorAll('.apr').forEach((b) => b.addEventListener('click', async () => {
    const next = people.filter((_, i) => i !== Number(b.dataset.i));
    await col('customers').doc(c.id).update({ authorized_people: next });
    c.authorized_people = next;
    openAuthorizedModal(c, onDone);
    onDone();
  }));
}

// 6. PRODUTOS
async function renderProducts(container) {
  const products = await fetchAll('products', 'description');
  container.innerHTML = `
    <div class="page-header"><h1>Cadastro de Produtos</h1><div class="btn-group"><button class="btn btn-outline btn-lg" id="pi-btn">📥 Importar Planilha</button><button class="btn btn-primary btn-lg" id="pn-btn">➕ Novo Produto</button></div></div>
    <div class="card"><input type="text" id="ps" placeholder="Pesquisar..." /></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Código</th><th>Descrição</th><th>Unid.</th><th class="text-right">Preço</th><th>Situação</th><th></th></tr></thead><tbody id="ptb"></tbody></table></div></div>
  `;
  function draw(q = '') {
    const t = q.toLowerCase();
    const list = t ? products.filter((p) => `${p.internal_code} ${p.barcode} ${p.description} ${p.brand}`.toLowerCase().includes(t)) : products;
    document.getElementById('ptb').innerHTML = list.map((p) => `<tr><td><strong>${escapeHtml(p.internal_code)}</strong></td><td>${escapeHtml(p.description)}</td><td>${escapeHtml(p.unit)}</td><td class="text-right"><strong>${formatCents(p.price_cents)}</strong></td><td><span class="badge badge-${p.status}">${p.status}</span></td><td class="text-right"><button class="btn btn-dark btn-sm pe" data-id="${p.id}">Editar</button></td></tr>`).join('');
    document.querySelectorAll('.pe').forEach((b) => b.addEventListener('click', () => openProductModal(products.find((x) => x.id === b.dataset.id), () => renderProducts(container))));
  }
  document.getElementById('ps').addEventListener('input', (e) => draw(e.target.value));
  document.getElementById('pn-btn').addEventListener('click', () => openProductModal(null, () => renderProducts(container)));
  document.getElementById('pi-btn').addEventListener('click', () => openSpreadsheetImportModal('products', products, () => renderProducts(container)));
  draw();
}

function openProductModal(p, onDone) {
  openModal(p ? `Editar ${p.internal_code}` : 'Novo Produto', `<form id="pf" class="form-stack"><div class="grid-2"><div><label>Código Interno *</label><input type="text" id="pc" required value="${escapeHtml(p?.internal_code || '')}" /></div><div><label>Código de Barras</label><input type="text" id="pb" value="${escapeHtml(p?.barcode || '')}" /></div></div><div><label>Descrição *</label><input type="text" id="pd" required value="${escapeHtml(p?.description || '')}" /></div><div class="grid-3"><div><label>Unidade</label><select id="pu">${['unidade', 'metro', 'rolo', 'caixa', 'pacote', 'peça', 'kg', 'litro'].map((u) => `<option value="${u}" ${p?.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div><div><label>Preço (R$) *</label><input type="text" id="pp" required value="${p ? (p.price_cents / 100).toFixed(2).replace('.', ',') : ''}" /></div><div><label>Situação</label><select id="ps"><option value="ativo" ${p?.status !== 'inativo' ? 'selected' : ''}>Ativo</option><option value="inativo" ${p?.status === 'inativo' ? 'selected' : ''}>Inativo</option></select></div></div><button type="submit" class="btn btn-primary btn-lg">Salvar</button></form>`);
  document.getElementById('pf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = { internal_code: document.getElementById('pc').value.trim(), barcode: document.getElementById('pb').value.trim(), description: document.getElementById('pd').value.trim(), unit: document.getElementById('pu').value, price_cents: parseBRCurrency(document.getElementById('pp').value), status: document.getElementById('ps').value };
    if (p) await col('products').doc(p.id).update(payload);
    else await col('products').add({ ...payload, created_at: nowLocalISO() });
    toast('Produto salvo!');
    closeModal();
    await onDone();
  });
}

function openSpreadsheetImportModal(type, existingList, onDone) {
  openModal(`Importar ${type === 'products' ? 'Produtos' : 'Clientes'} (.xlsx / .csv)`, `<div class="form-stack"><button class="btn btn-outline" id="imp-tpl">📥 Baixar Modelo (.xlsx)</button><input type="file" id="imp-f" accept=".xlsx,.csv,.txt" /><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="imp-upd" checked style="width:18px;height:18px" /><span>Atualizar registros já existentes</span></label><button class="btn btn-primary btn-lg" id="imp-go">🚀 Importar</button></div>`);
  document.getElementById('imp-tpl').addEventListener('click', () => {
    const rows = type === 'products' ? [{ Codigo: 'CABO25', Barras: '', Descricao: 'Cabo 2,5mm', Unidade: 'metro', Preco: 3.5, Situacao: 'ativo' }] : [{ Nome: 'Cliente Exemplo', CPF_CNPJ: '', Telefone: '', Endereco: '', Situacao: 'ativo' }];
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dados');
    XLSX.writeFile(wb, `modelo_${type}.xlsx`);
  });
  document.getElementById('imp-go').addEventListener('click', async () => {
    const file = document.getElementById('imp-f').files?.[0];
    if (!file) return toast('Selecione um arquivo.', true);
    const updateExisting = document.getElementById('imp-upd').checked;
    const btn = document.getElementById('imp-go');
    btn.disabled = true;
    btn.textContent = 'Importando...';
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      const ops = [];
      let created = 0;
      let updated = 0;

      const byCode = new Map(existingList.map((p) => [String(p.internal_code || '').toLowerCase(), p]));
      const byDoc = new Map(existingList.filter((c) => c.document).map((c) => [String(c.document).trim(), c]));
      const byName = new Map(existingList.map((c) => [String(c.name || '').trim().toLowerCase(), c]));

      for (const r of rows) {
        const norm = {};
        for (const [k, v] of Object.entries(r)) norm[k.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')] = String(v ?? '').trim();
        if (type === 'products') {
          const code = norm.codigointerno || norm.codigo || norm.cod || '';
          const desc = norm.descricao || norm.nome || norm.produto || '';
          if (!code || !desc) continue;
          const payload = { internal_code: code, barcode: norm.codigobarras || norm.ean || '', description: desc, unit: norm.unidade || 'unidade', price_cents: parseBRCurrency(norm.preco || norm.precodevenda || '0'), status: 'ativo' };
          const existing = byCode.get(code.toLowerCase());
          if (existing) {
            if (updateExisting) {
              ops.push({ type: 'update', ref: col('products').doc(existing.id), data: payload });
              updated++;
            }
          } else {
            const newRef = col('products').doc();
            ops.push({ type: 'set', ref: newRef, data: { ...payload, created_at: nowLocalISO() } });
            byCode.set(code.toLowerCase(), { id: newRef.id, ...payload });
            created++;
          }
        } else {
          const name = norm.nome || norm.razaosocial || norm.cliente || '';
          if (!name) continue;
          const docVal = norm.cpfcnpj || norm.cpf || norm.cnpj || '';
          const payload = { name, document: docVal, phone: norm.telefone || norm.whatsapp || '', address: norm.endereco || '', notes: '', status: 'ativo' };
          const existing = (docVal ? byDoc.get(docVal) : null) || byName.get(name.toLowerCase());
          if (existing) {
            if (updateExisting) {
              ops.push({ type: 'update', ref: col('customers').doc(existing.id), data: payload });
              updated++;
            }
          } else {
            const newRef = col('customers').doc();
            ops.push({ type: 'set', ref: newRef, data: { ...payload, authorized_people: [], created_at: nowLocalISO() } });
            byName.set(name.toLowerCase(), { id: newRef.id, ...payload });
            created++;
          }
        }
      }

      // Firestore batch limit is 500 writes -> chunk by 450
      for (let i = 0; i < ops.length; i += 450) {
        const batch = db.batch();
        for (const op of ops.slice(i, i + 450)) {
          if (op.type === 'update') batch.update(op.ref, op.data);
          else batch.set(op.ref, op.data);
        }
        await batch.commit();
      }
      toast(`Importação concluída: ${created} novos, ${updated} atualizados!`);
      closeModal();
      await onDone();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = '🚀 Importar';
    }
  });
}

// 7. RELATÓRIOS
async function renderReports(container) {
  const customers = await fetchAll('customers', 'name');
  container.innerHTML = `<div class="page-header"><h1>Relatórios</h1></div><div class="card"><div class="grid-4"><div><label>Tipo</label><select id="rt"><option value="customer">Por Cliente</option><option value="period">Por Período</option><option value="product">Por Produto</option></select></div><div><label>Cliente</label><select id="rc"><option value="">Todos</option>${customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></div><div><label>Início</label><input type="date" id="rs" /></div><div><label>Fim</label><input type="date" id="re" /></div></div><div class="btn-group" style="margin-top:12px"><button class="btn btn-dark" id="rr">📊 Gerar</button><button class="btn btn-primary" id="rp">📄 PDF</button><button class="btn btn-success" id="rx">📗 Excel</button></div></div><div id="rout" class="card"></div>`;
  let lastData = null;
  async function run() {
    const type = document.getElementById('rt').value;
    const cid = document.getElementById('rc').value;
    const s = document.getElementById('rs').value;
    const e = document.getElementById('re').value;
    const allW = (await fetchAll('withdrawals', 'withdrawal_date', true)).map(enrichWithdrawal).filter((w) => w.status !== 'cancelada' && (!cid || w.customer_id === cid) && (!s || w.withdrawal_date.slice(0, 10) >= s) && (!e || w.withdrawal_date.slice(0, 10) <= e));
    const out = document.getElementById('rout');
    if (type === 'customer') {
      const m = new Map();
      for (const w of allW) {
        if (!m.has(w.customer_id)) m.set(w.customer_id, { name: w.customer_name, open: 0, closed: 0, total: 0 });
        const en = m.get(w.customer_id);
        if (w.status === 'aberta') en.open += w.net_total_cents; else en.closed += w.net_total_cents;
        en.total += w.net_total_cents;
      }
      const items = Array.from(m.values());
      lastData = { title: 'RELATÓRIO POR CLIENTE', headers: ['Cliente', 'Aberto', 'Fechado', 'Total'], rows: items.map((x) => [x.name, formatCents(x.open), formatCents(x.closed), formatCents(x.total)]) };
      out.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Cliente</th><th class="text-right">Aberto</th><th class="text-right">Fechado</th><th class="text-right">Total</th></tr></thead><tbody>${lastData.rows.map((r) => `<tr><td><strong>${escapeHtml(r[0])}</strong></td><td class="text-right">${r[1]}</td><td class="text-right">${r[2]}</td><td class="text-right"><strong>${r[3]}</strong></td></tr>`).join('')}</tbody></table></div>`;
    } else if (type === 'product') {
      const m = new Map();
      for (const w of allW) for (const it of w.items) {
        const k = `${it.product_code}::${it.product_unit}`;
        if (!m.has(k)) m.set(k, { code: it.product_code, desc: it.product_description, unit: it.product_unit, qty: 0, total: 0 });
        const en = m.get(k); en.qty += it.quantity; en.total += it.subtotal_cents;
      }
      const items = Array.from(m.values());
      lastData = { title: 'RELATÓRIO POR PRODUTO', headers: ['Código', 'Produto', 'Unid.', 'Qtd.', 'Total'], rows: items.map((x) => [x.code, x.desc, x.unit, formatQty(x.qty), formatCents(x.total)]) };
      out.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Código</th><th>Produto</th><th>Unid.</th><th class="text-right">Qtd.</th><th class="text-right">Total</th></tr></thead><tbody>${lastData.rows.map((r) => `<tr><td>${escapeHtml(r[0])}</td><td><strong>${escapeHtml(r[1])}</strong></td><td>${escapeHtml(r[2])}</td><td class="text-right">${r[3]}</td><td class="text-right"><strong>${r[4]}</strong></td></tr>`).join('')}</tbody></table></div>`;
    } else {
      lastData = { title: 'RELATÓRIO POR PERÍODO', headers: ['Código', 'Data', 'Cliente', 'Status', 'Total'], rows: allW.map((w) => [w.code, formatDateTime(w.withdrawal_date), w.customer_name, w.status.toUpperCase(), formatCents(w.net_total_cents)]) };
      out.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Código</th><th>Data</th><th>Cliente</th><th>Status</th><th class="text-right">Total</th></tr></thead><tbody>${lastData.rows.map((r) => `<tr><td><strong>${escapeHtml(r[0])}</strong></td><td>${r[1]}</td><td>${escapeHtml(r[2])}</td><td>${r[3]}</td><td class="text-right"><strong>${r[4]}</strong></td></tr>`).join('')}</tbody></table></div>`;
    }
  }
  document.getElementById('rr').addEventListener('click', run);
  document.getElementById('rp').addEventListener('click', () => lastData && window.exportReportPDF({ ...lastData, subtitle: '', store: state.store }));
  document.getElementById('rx').addEventListener('click', () => {
    if (!lastData) return;
    const ws = XLSX.utils.aoa_to_sheet([lastData.headers, ...lastData.rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Relatorio');
    XLSX.writeFile(wb, 'relatorio_construcenter.xlsx');
  });
  await run();
}

// 8. ADMINISTRAÇÃO
async function renderAdmin(container) {
  const isAdmin = state.user.role === 'admin';
  const [logs, users] = await Promise.all([fetchAll('audit_logs', 'created_at', true), isAdmin ? fetchAll('users', 'name') : Promise.resolve([])]);
  container.innerHTML = `
    <div class="page-header"><h1>Administração & Segurança</h1></div>
    ${isAdmin ? `<div class="grid-2">
      <div class="card"><div style="display:flex;justify-content:space-between;margin-bottom:10px"><h2 class="card-title" style="margin:0">Usuários</h2><button class="btn btn-primary btn-sm" id="anu">➕ Novo Usuário</button></div><div class="table-wrap"><table><thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Status</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.username)}</td><td><span class="badge badge-orange">${u.role}</span></td><td><span class="badge badge-${u.active ? 'ativo' : 'inativo'}">${u.active ? 'Ativo' : 'Inativo'}</span></td><td class="text-right">${u.id === state.user.uid ? '<span class="muted">Você</span>' : `<button class="btn btn-outline btn-sm aeu" data-id="${u.id}">Editar</button>`}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><h2 class="card-title">Dados da Loja</h2><form id="asf" class="form-stack"><div><label>Nome</label><input type="text" id="sn" value="${escapeHtml(state.store.name)}" /></div><div><label>CNPJ</label><input type="text" id="sc" value="${escapeHtml(state.store.cnpj || '')}" /></div><div><label>Telefone</label><input type="text" id="sp" value="${escapeHtml(state.store.phone || '')}" /></div><div><label>Endereço</label><input type="text" id="sa" value="${escapeHtml(state.store.address || '')}" /></div><div><label>Logo da Empresa (PNG/JPG)</label><div style="display:flex;align-items:center;gap:12px;margin:6px 0"><img id="sl-preview" src="${escapeHtml(state.store.logo_data_url || '/logo.jpeg')}" alt="Logo atual" style="height:44px;max-width:160px;object-fit:contain;border:1px solid #e2e8f0;border-radius:6px;padding:4px;background:#fff" /><button type="button" id="sl-clear" class="btn btn-outline btn-sm">Usar Padrão</button></div><input type="file" id="sl" accept="image/*" /></div><button type="submit" class="btn btn-dark">Salvar</button></form></div>
    </div>` : ''}
    <div class="card"><h2 class="card-title">Auditoria</h2><div class="table-wrap"><table><thead><tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Entidade</th><th>Detalhes</th></tr></thead><tbody>${logs.slice(0, 60).map((l) => `<tr><td>${formatDateTime(l.created_at)}</td><td>${escapeHtml(l.user_name)}</td><td><strong>${escapeHtml(l.action)}</strong></td><td>${escapeHtml(l.entity)}</td><td class="muted">${escapeHtml(l.reason || l.details)}</td></tr>`).join('')}</tbody></table></div></div>
  `;
  if (isAdmin) {
    let pendingLogoDataUrl = state.store.logo_data_url || '';
    const logoInput = document.getElementById('sl');
    const logoPreview = document.getElementById('sl-preview');
    logoInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        pendingLogoDataUrl = await resizeLogoToDataUrl(file);
        logoPreview.src = pendingLogoDataUrl;
      } catch (err) {
        toast(err.message, true);
      }
    });
    document.getElementById('sl-clear').addEventListener('click', () => {
      pendingLogoDataUrl = '';
      logoInput.value = '';
      logoPreview.src = '/logo.jpeg';
    });
    document.getElementById('asf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const s = { ...state.store, name: document.getElementById('sn').value.trim(), cnpj: document.getElementById('sc').value.trim(), phone: document.getElementById('sp').value.trim(), address: document.getElementById('sa').value.trim(), logo_data_url: pendingLogoDataUrl };
      await col('meta').doc('store_settings').set(s);
      state.store = s;
      applyTenantBranding(s);
      toast('Dados salvos!');
    });
    document.querySelectorAll('.aeu').forEach((b) => {
      b.addEventListener('click', () => {
        const u = users.find((x) => x.id === b.dataset.id);
        if (!u) return;
        openModal(`Editar Usuário — ${u.username}`, `<form id="euf" class="form-stack"><div><label>Nome *</label><input type="text" id="eun" required value="${escapeHtml(u.name)}" /></div><div><label>Perfil</label><select id="eur"><option value="atendente" ${u.role === 'atendente' ? 'selected' : ''}>Atendente</option><option value="gerente" ${u.role === 'gerente' ? 'selected' : ''}>Gerente</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option></select></div><div><label>Situação</label><select id="eua"><option value="1" ${u.active ? 'selected' : ''}>Ativo</option><option value="0" ${!u.active ? 'selected' : ''}>Inativo</option></select></div><button type="submit" class="btn btn-primary btn-lg">Salvar Alterações</button></form>`);
        document.getElementById('euf').addEventListener('submit', async (e) => {
          e.preventDefault();
          await col('users').doc(u.id).update({
            name: document.getElementById('eun').value.trim(),
            role: document.getElementById('eur').value,
            active: document.getElementById('eua').value === '1',
          });
          toast('Usuário atualizado!');
          closeModal();
          renderAdmin(container);
        });
      });
    });

    document.getElementById('anu').addEventListener('click', () => {
      openModal('Novo Usuário', `<form id="nuf" class="form-stack"><div><label>Nome *</label><input type="text" id="nun" required /></div><div><label>Usuário *</label><input type="text" id="nuu" required /></div><div><label>Perfil</label><select id="nur"><option value="atendente">Atendente</option><option value="gerente">Gerente</option><option value="admin">Administrador</option></select></div><div><label>Senha (mín. 6 caracteres) *</label><input type="password" id="nup" required minlength="6" /></div><button type="submit" class="btn btn-primary btn-lg">Criar Usuário</button></form>`);
      document.getElementById('nuf').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const secApp = firebase.apps.find((a) => a.name === 'secondary') || firebase.initializeApp(config, 'secondary');
          const secAuth = secApp.auth();
          const uname = document.getElementById('nuu').value.trim().toLowerCase();
          const email = toAuthEmail(uname);
          const cred = await secAuth.createUserWithEmailAndPassword(email, document.getElementById('nup').value);
          await col('users').doc(cred.user.uid).set({ name: document.getElementById('nun').value.trim(), username: uname, email, role: document.getElementById('nur').value, active: true, created_at: nowLocalISO() });
          await secAuth.signOut();
          toast('Usuário criado!');
          closeModal();
          renderAdmin(container);
        } catch (err) { toast(err.message, true); }
      });
    });
  }
}
