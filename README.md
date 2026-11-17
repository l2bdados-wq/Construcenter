# Construcenter — Controle de Retiradas e Fechamento de Pedidos

Sistema web responsivo em português do Brasil para controle de retiradas de produtos em conta aberta por cliente, devoluções, fechamento transacional de período e geração de pedidos consolidados em PDF ("Pedido — sem valor fiscal") e relatórios em PDF/Excel.

## Requisitos

- **Node.js 24+** (utiliza o módulo nativo `node:sqlite`, sem necessidade de compilação nativa no Windows).
- `logo.jpeg` na raiz do projeto (utilizada automaticamente no sistema, nos comprovantes e nos PDFs).

## Instalação

1. Instale as dependências:
   ```bash
   npm install
   ```

2. **(Opcional) Criar o primeiro Administrador pelo terminal:**
   ```bash
   npm run setup
   ```
   > **Dica:** Se você pular este passo, ao abrir o sistema no navegador pela primeira vez será exibida automaticamente a tela de **Configuração Inicial** para cadastrar o primeiro Administrador.

3. **Iniciar o servidor:**
   ```bash
   npm start
   ```
   Acesse no navegador: `http://localhost:3000` (ou pelo IP da máquina na rede local para usar no celular/tablet).

## Banco de Dados e Backups

- O banco SQLite persistente é criado automaticamente em `data/construcenter.db` (modo WAL e transações `BEGIN IMMEDIATE` para evitar duplicidades em acessos simultâneos).
- Variáveis de ambiente opcionais:
  - `PORT` (padrão: `3000`)
  - `DATA_DIR` (padrão: `./data`)
  - `DB_PATH` (padrão: `./data/construcenter.db`)
  - `BACKUP_DIR` (padrão: `./data/backups`)
- **Backup Automático:** O sistema gera snapshots consistentes (`VACUUM INTO`) automaticamente a cada 6 horas em `data/backups/`, mantendo os 30 backups mais recentes. Administradores também podem gerar e baixar backups manualmente na aba **Administração**.

## Perfis de Acesso

- **Administrador (`admin`):** Acesso completo, incluindo usuários, configurações da loja, backups, auditoria, fechamentos e correções.
- **Gerente (`gerente`):** Fechamento de pedidos, descontos, devoluções, cancelamentos, correções pós-fechamento e visualização do histórico de auditoria.
- **Atendente (`atendente`):** Cadastro de clientes/produtos, registro de retiradas, devoluções e emissão de comprovantes.

## Validação Automatizada (Fluxo Completo)

Para executar a suíte de validação ponta a ponta (em banco isolado de teste):

```bash
npm run test:e2e
```
