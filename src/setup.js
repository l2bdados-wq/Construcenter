const bcrypt = require('bcryptjs');
const readline = require('node:readline');
const { db } = require('./db/database');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

async function main() {
  console.log('=== Construcenter - Configuração Inicial do Banco e Administrador ===');
  const existing = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
  if (existing > 0) {
    console.log(`Já existem ${existing} usuário(s) cadastrado(s).`);
    rl.close();
    return;
  }

  const name = (await ask('Nome completo do Administrador: ')).trim() || 'Administrador';
  const username = ((await ask('Usuário para login (ex: admin): ')).trim() || 'admin').toLowerCase();
  const password = (await ask('Senha (mín. 4 caracteres): ')).trim() || 'admin123';

  if (password.length < 4) {
    console.error('Senha muito curta.');
    rl.close();
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (name, username, password_hash, role, active) VALUES (?, ?, ?, ?, 1)'
  ).run(name, username, hash, 'admin');

  console.log(`\nAdministrador "${username}" criado com sucesso!`);
  console.log('Execute "npm start" e acesse http://localhost:3000');
  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
