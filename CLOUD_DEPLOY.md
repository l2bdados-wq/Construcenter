# Implantação em Nuvem — `l2sistemas.api.br` (Multi-Empresas por Subdomínio)

O sistema já está preparado para funcionar na nuvem atendendo múltiplos clientes em subdomínios separados, com **banco de dados e backups 100% isolados por loja**:

- **Portal L2 Sistemas (Gerenciar Lojas):** `https://l2sistemas.api.br`
- **Construcenter:** `https://construcenter.l2sistemas.api.br`
- **Próximos clientes:** `https://nomedaloja.l2sistemas.api.br` (criados direto pelo Portal!)

---

## Passo 1: Configurar o DNS do domínio `l2sistemas.api.br`

No painel onde você registrou o domínio (Registro.br, Cloudflare, Hostinger, etc.), crie **dois registros do tipo `A`** apontando para o **IP público da sua VPS**:

| Tipo | Nome / Host | Valor |
|------|-------------|-------|
| `A`  | `@` (ou `l2sistemas.api.br`) | `IP_DA_SUA_VPS` |
| `A`  | `*` (ou `*.l2sistemas.api.br`) | `IP_DA_SUA_VPS` |

> O registro `*` (wildcard) faz com que qualquer subdomínio (`construcenter.l2sistemas.api.br`, `loja2.l2sistemas.api.br`, etc.) chegue automaticamente no seu servidor sem precisar editar o DNS toda vez.

---

## Passo 2: Subir o sistema na VPS (Ubuntu/Debian)

1. Conecte na VPS via SSH e instale o **Node.js 24+** (ou Docker):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs nginx
   ```
2. Envie a pasta do projeto para `/opt/l2sistemas` (via `git`, `scp` ou `rsync`) e instale as dependências:
   ```bash
   cd /opt/l2sistemas
   npm install --omit=dev
   ```
3. Defina uma chave forte para o Super-Admin e inicie com **PM2**:
   ```bash
   sudo npm install -g pm2
   SUPER_ADMIN_KEY="SuaChaveSecretaAqui" pm2 start src/server.js --name l2sistemas
   pm2 save
   pm2 startup
   ```

---

## Passo 3: Configurar Nginx e HTTPS

1. Copie o arquivo `nginx.conf` do projeto para o Nginx:
   ```bash
   sudo cp /opt/l2sistemas/nginx.conf /etc/nginx/sites-available/l2sistemas.api.br
   sudo ln -s /etc/nginx/sites-available/l2sistemas.api.br /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```
2. Para HTTPS automático em **todos os subdomínios (`*.l2sistemas.api.br`)**:
   - **Opção recomendada:** use a **Cloudflare** (plano gratuito) gerenciando o DNS de `l2sistemas.api.br` com SSL/TLS no modo **Full** e Origin Certificate instalado no Nginx, **ou** gere um certificado Wildcard via Certbot (`certbot certonly --manual --preferred-challenges dns -d l2sistemas.api.br -d *.l2sistemas.api.br`).

---

## Como funciona no dia a dia

1. **Construcenter** já vem pré-cadastrada: acesse **`https://construcenter.l2sistemas.api.br`**.
2. Para criar um novo cliente (ex.: `eletricasilva.l2sistemas.api.br`):
   - Acesse **`https://l2sistemas.api.br`**, informe sua `SUPER_ADMIN_KEY` e clique em **➕ Criar Sistema**.
   - O novo endereço já fica ativo imediatamente com banco de dados isolado, backups automáticos em `data/tenants/<slug>/backups/` e tela de **Configuração Inicial** para o novo cliente criar o próprio administrador.
3. Você também pode **Suspender** ou **Reativar** qualquer loja com 1 clique no Portal L2 Sistemas.
