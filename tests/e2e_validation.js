const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Use isolated test database
const testDbPath = path.join(__dirname, '..', 'data', 'test_e2e.db');
for (const f of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = testDbPath;

const { createApp } = require('../src/server');

async function request(baseUrl, method, urlPath, body = null, cookie = '') {
  const headers = {};
  if (cookie) headers['Cookie'] = cookie;
  if (body !== null) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie');
  const nextCookie = setCookie ? setCookie.split(';')[0] : cookie;
  const contentType = res.headers.get('content-type') || '';

  let data;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = Buffer.from(await res.arrayBuffer());
  }
  return { status: res.status, data, cookie: nextCookie, contentType };
}

async function main() {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    console.log('Iniciando validação E2E do sistema Construcenter...');

    // Setup inicial do Administrador
    const setupRes = await request(baseUrl, 'POST', '/api/auth/setup', {
      name: 'Administrador Geral',
      username: 'admin',
      password: 'admin123',
    });
    assert.equal(setupRes.status, 201);
    const adminCookie = setupRes.cookie;
    console.log('✓ Administrador inicial criado e autenticado');

    // Criar usuário Atendente para testar permissões
    const attCreate = await request(
      baseUrl,
      'POST',
      '/api/admin/users',
      { name: 'Atendente João', username: 'joao', password: '1234', role: 'atendente' },
      adminCookie
    );
    assert.equal(attCreate.status, 201);
    const attLogin = await request(baseUrl, 'POST', '/api/auth/login', {
      username: 'joao',
      password: '1234',
    });
    assert.equal(attLogin.status, 200);
    const attCookie = attLogin.cookie;

    // 1. Cadastrar o cliente Lucas (com pessoa autorizada)
    const custRes = await request(
      baseUrl,
      'POST',
      '/api/customers',
      {
        name: 'Lucas',
        document: '123.456.789-00',
        phone: '(77) 99999-1111',
        address: 'Rua das Flores, 100',
        authorized_people: [{ name: 'Carlos Eletricista', identification: 'RG 987654' }],
      },
      adminCookie
    );
    assert.equal(custRes.status, 201);
    const lucas = custRes.data;
    assert.equal(lucas.name, 'Lucas');
    assert.equal(lucas.authorized_people.length, 1);
    console.log('✓ Passo 1: Cliente Lucas cadastrado com pessoa autorizada');

    // Cadastrar 5 produtos para as retiradas
    const prodSpecs = [
      { internal_code: 'CABO25', description: 'Cabo Flexível 2,5mm Preto', unit: 'metro', price: '3,50' },
      { internal_code: 'DISJ20', description: 'Disjuntor DIN 20A', unit: 'unidade', price: '18,90' },
      { internal_code: 'TOM10', description: 'Tomada 10A c/ Espelho', unit: 'unidade', price: '12,00' },
      { internal_code: 'FITAISO', description: 'Fita Isolante 20m', unit: 'rolo', price: '8,50' },
      { internal_code: 'LAMP9W', description: 'Lâmpada LED 9W', unit: 'unidade', price: '9,90' },
    ];
    const products = [];
    for (const p of prodSpecs) {
      const r = await request(baseUrl, 'POST', '/api/products', p, adminCookie);
      assert.equal(r.status, 201);
      products.push(r.data);
    }

    // Testar que atendente não pode conceder desconto
    const attDiscAttempt = await request(
      baseUrl,
      'POST',
      '/api/withdrawals',
      {
        customer_id: lucas.id,
        withdrawal_date: '2026-11-02 09:00:00',
        picked_up_by: 'Lucas',
        discount_cents: 500,
        items: [{ product_id: products[0].id, quantity: 1 }],
      },
      attCookie
    );
    assert.equal(attDiscAttempt.status, 403);

    // 2. Registrar uma retirada em 02/11 com 3 itens (incluindo quantidade fracionada 2,5m)
    const w1IdemKey = 'test-idem-w1';
    const w1Payload = {
      customer_id: lucas.id,
      withdrawal_date: '2026-11-02 10:15:00',
      picked_up_by: 'Carlos Eletricista',
      work_reference: 'Obra Residencial Lucas',
      items: [
        { product_id: products[0].id, quantity: 2.5 }, // 2.5 * 350 = 875 centavos
        { product_id: products[1].id, quantity: 2 },   // 2 * 1890 = 3780
        { product_id: products[2].id, quantity: 4 },   // 4 * 1200 = 4800
      ],
      idempotency_key: w1IdemKey,
    };
    const w1Res = await request(baseUrl, 'POST', '/api/withdrawals', w1Payload, attCookie);
    assert.equal(w1Res.status, 201);
    const w1 = w1Res.data;
    assert.equal(w1.items.length, 3);
    assert.equal(w1.net_total_cents, 875 + 3780 + 4800); // 9455 (R$ 94,55)

    // Testar idempotência (clique repetido não duplica)
    const w1Dup = await request(baseUrl, 'POST', '/api/withdrawals', w1Payload, attCookie);
    assert.equal(w1Dup.data.id, w1.id);
    console.log(`✓ Passo 2: Retirada 02/11 (${w1.code}) registrada com 3 itens (R$ 94,55) e idempotência validada`);

    // Alterar preço do produto 0 no cadastro para R$ 4,00 e confirmar que w1 preservou R$ 3,50
    const updProd = await request(
      baseUrl,
      'PUT',
      `/api/products/${products[0].id}`,
      {
        internal_code: products[0].internal_code,
        description: products[0].description,
        unit: products[0].unit,
        price: '4,00',
      },
      adminCookie
    );
    assert.equal(updProd.status, 200);
    assert.equal(updProd.data.price_cents, 400);

    // 3. Registrar outra retirada em 10/11 com 5 itens
    const w2Res = await request(
      baseUrl,
      'POST',
      '/api/withdrawals',
      {
        customer_id: lucas.id,
        withdrawal_date: '2026-11-10 14:30:00',
        picked_up_by: 'Lucas',
        work_reference: 'Obra Residencial Lucas',
        items: [
          { product_id: products[0].id, quantity: 10 },
          { product_id: products[1].id, quantity: 1 },
          { product_id: products[2].id, quantity: 2 },
          { product_id: products[3].id, quantity: 3 },
          { product_id: products[4].id, quantity: 6 },
        ],
        idempotency_key: 'test-idem-w2',
      },
      attCookie
    );
    assert.equal(w2Res.status, 201);
    const w2 = w2Res.data;
    assert.equal(w2.items.length, 5);
    console.log(`✓ Passo 3: Retirada 10/11 (${w2.code}) registrada com 5 itens`);

    // 4. Mostrar ambas na conta aberta
    const openAcc = await request(
      baseUrl,
      'GET',
      `/api/withdrawals?customer_id=${lucas.id}&status=aberta`,
      null,
      adminCookie
    );
    assert.equal(openAcc.status, 200);
    assert.equal(openAcc.data.withdrawals.length, 2);
    const checkW1 = openAcc.data.withdrawals.find((x) => x.id === w1.id);
    assert.equal(checkW1.items[0].unit_price_cents, 350); // Preço original preservado!
    console.log('✓ Passo 4: Ambas retiradas exibidas na conta aberta com preços originais preservados');

    // Testar devolução e bloqueio acima da quantidade retirada
    const overRet = await request(
      baseUrl,
      'POST',
      `/api/withdrawals/${w2.id}/returns`,
      { withdrawal_item_id: w2.items[4].id, quantity: 10, reason: 'Excesso' },
      adminCookie
    );
    assert.equal(overRet.status, 400);

    // 5. Fechar somente a primeira (02/11) e manter a segunda (10/11) aberta
    // Primeiro confirmar que atendente não pode fechar
    const attOrderAttempt = await request(
      baseUrl,
      'POST',
      '/api/orders',
      { customer_id: lucas.id, withdrawal_ids: [w1.id] },
      attCookie
    );
    assert.equal(attOrderAttempt.status, 403);

    const orderRes = await request(
      baseUrl,
      'POST',
      '/api/orders',
      {
        customer_id: lucas.id,
        period_start: '2026-11-01',
        period_end: '2026-11-05',
        withdrawal_ids: [w1.id],
        payment_condition: 'PIX 15 dias',
        due_date: '2026-11-20',
        notes: 'Fechamento parcial de novembro',
        idempotency_key: 'test-idem-order1',
      },
      adminCookie
    );
    assert.equal(orderRes.status, 201);
    const order = orderRes.data;
    assert.equal(order.total_cents, 9455);

    // Verificar que w1 está fechada e w2 continua aberta
    const afterOpen = await request(
      baseUrl,
      'GET',
      `/api/withdrawals?customer_id=${lucas.id}&status=aberta`,
      null,
      adminCookie
    );
    assert.equal(afterOpen.data.withdrawals.length, 1);
    assert.equal(afterOpen.data.withdrawals[0].id, w2.id);
    console.log(`✓ Passo 5: Pedido ${order.order_number} gerado fechando somente ${w1.code}; ${w2.code} permanece aberta`);

    // 6. Gerar o PDF do pedido
    const pdfRes = await request(
      baseUrl,
      'GET',
      `/api/orders/${order.id}/pdf?mode=both`,
      null,
      adminCookie
    );
    assert.equal(pdfRes.status, 200);
    assert.ok(pdfRes.contentType.includes('application/pdf'));
    assert.equal(pdfRes.data.slice(0, 4).toString(), '%PDF');
    console.log('✓ Passo 6: PDF do pedido gerado com sucesso (%PDF válido)');

    // 7. Confirmar que a retirada fechada não pode ser incluída novamente
    const dupOrderRes = await request(
      baseUrl,
      'POST',
      '/api/orders',
      {
        customer_id: lucas.id,
        withdrawal_ids: [w1.id],
        idempotency_key: 'test-idem-order-dup',
      },
      adminCookie
    );
    assert.equal(dupOrderRes.status, 409);
    console.log('✓ Passo 7: Bloqueio confirmado — retirada fechada não pode entrar em outro pedido (HTTP 409)');

    // Bloqueio de edição direta em retirada fechada + correção pós-fechamento com motivo
    const directEdit = await request(
      baseUrl,
      'PUT',
      `/api/withdrawals/${w1.id}`,
      { notes: 'Tentativa direta' },
      adminCookie
    );
    assert.equal(directEdit.status, 403);

    const postCorr = await request(
      baseUrl,
      'POST',
      `/api/withdrawals/${w1.id}/correct`,
      { reason: 'Ajuste de referência da obra', work_reference: 'Obra Residencial Lucas - Etapa 2' },
      adminCookie
    );
    assert.equal(postCorr.status, 200);
    assert.equal(postCorr.data.corrections.length, 1);
    console.log('✓ Edição direta bloqueada após fechamento e correção com motivo preservando histórico validada');

    // Testar exportação de relatórios PDF e Excel
    const repPdf = await request(baseUrl, 'GET', '/api/reports/export/pdf?type=customer', null, adminCookie);
    assert.equal(repPdf.status, 200);
    assert.equal(repPdf.data.slice(0, 4).toString(), '%PDF');

    const repXlsx = await request(baseUrl, 'GET', '/api/reports/export/excel?type=product', null, adminCookie);
    assert.equal(repXlsx.status, 200);
    assert.ok(repXlsx.data.length > 100);
    console.log('✓ Exportação de relatórios PDF e Excel (.xlsx) validada');

    // Testar importação de Produtos e Clientes via CSV
    const csvProdutos = 'Codigo;Descricao;Unidade;Preco\nIMP001;Conduíte Corrugado 3/4;metro;2,45\nCABO25;Cabo Flexível 2,5mm Preto;metro;4,20\n';
    const impProdRes = await request(
      baseUrl,
      'POST',
      '/api/products/import',
      {
        filename: 'produtos.csv',
        contentBase64: Buffer.from(csvProdutos, 'utf8').toString('base64'),
        updateExisting: true,
      },
      adminCookie
    );
    assert.equal(impProdRes.status, 200);
    assert.equal(impProdRes.data.created, 1);
    assert.equal(impProdRes.data.updated, 1);

    const csvClientes = 'Nome;CPF/CNPJ;Telefone\nConstrutora Alpha;11.222.333/0001-44;(77) 98888-7777\n';
    const impCustRes = await request(
      baseUrl,
      'POST',
      '/api/customers/import',
      {
        filename: 'clientes.csv',
        contentBase64: Buffer.from(csvClientes, 'utf8').toString('base64'),
        updateExisting: true,
      },
      adminCookie
    );
    assert.equal(impCustRes.status, 200);
    assert.equal(impCustRes.data.created, 1);
    console.log('✓ Importação em lote de Produtos e Clientes (CSV/Excel) validada');

    console.log('\nTODOS OS TESTES DE VALIDAÇÃO PASSARAM COM SUCESSO!');
  } finally {
    server.close();
    for (const f of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`]) {
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch (_) {}
      }
    }
  }
}

main().catch((err) => {
  console.error('FALHA NA VALIDAÇÃO:', err);
  process.exit(1);
});
