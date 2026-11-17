# Versão 100% Firebase (Hosting + Auth + Firestore — Plano Spark Gratuito)

Esta versão roda **sem servidor Node.js, sem VPS e sem hibernar**, 100% dentro do plano gratuito **Spark** do Firebase.

## Passo 1 — Criar/Configurar o Projeto no Console do Firebase
1. Acesse **https://console.firebase.google.com** e crie (ou abra) seu projeto.
2. No menu lateral, ative:
   - **Authentication** → *Sign-in method* → ative **E-mail/senha**.
   - **Firestore Database** → **Criar banco de dados** → escolha a região **southamerica-east1 (São Paulo)** e inicie em modo de produção.
3. Em **Configurações do Projeto (⚙️)** → **Seus aplicativos** → clique no ícone Web (`</>`) para registrar um App Web e copie o objeto `firebaseConfig`.
4. Cole essas credenciais em [public_firebase/firebase-config.js](public_firebase/firebase-config.js).

## Passo 2 — Publicar no Firebase Hosting + Regras do Firestore
No terminal dentro desta pasta, execute:

```powershell
firebase login
firebase use --add
firebase deploy
```

## Passo 3 — Conectar o domínio `construcenter.l2sistemas.api.br`
1. No Console do Firebase → **Hosting** → **Adicionar domínio personalizado**.
2. Digite **`construcenter.l2sistemas.api.br`**.
3. O Firebase vai mostrar os registros `TXT` / `A` para você colocar na **Cloudflare** (substituindo os apontamentos antigos do Render).
4. Assim que propagar, o site abrirá com HTTPS automático do Google, sem dormir e sem custo mensal.
