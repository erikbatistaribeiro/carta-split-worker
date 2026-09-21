# Carta Split Worker

Cloudflare Worker que gera a Carta de Autorização Split de Pagamento automaticamente a partir de um card do Pipefy.

## Como funciona

1. O Pipefy iPaaS dispara um `POST /gerar-carta` quando o campo "Data Emissão da Carta" é preenchido
2. O Worker busca os dados do card via API do Pipefy
3. Gera o PDF da carta com pdf-lib (fiel ao modelo Word)
4. Anexa o PDF de volta no campo "Anexo Carta de Autorização" do card

## Campos do Pipefy utilizados

| Campo no Pipefy | Placeholder na carta |
|---|---|
| Data Emissão da Carta | [DATA_CARTA] |
| Valor total dos boletos | [VALOR_TOTAL_FINAL] |
| ID do contrato CCB | [ID_CONTRATO] |
| Data emissão do contrato CCB | [DATA_CONTRATO] |
| Dados Boleto | [DADOS_BOLETO] |
| Nome do Cliente | [NOME_CLIENTE] |
| CPF do Cliente | [CPF_CLIENTE] |

## Configuração

### 1. Clone o repositório
```bash
git clone https://github.com/seu-usuario/carta-split-worker
cd carta-split-worker
npm install
```

### 2. Configure as variáveis de ambiente

Para desenvolvimento local, copie `.dev.vars.example` para `.dev.vars` e preencha:
```bash
cp .dev.vars.example .dev.vars
```

Para produção, configure no Cloudflare Dashboard:
- **Settings → Variables → Add variable** (marque como Secret)
  - `PIPEFY_TOKEN` → token Bearer do Pipefy
  - `WORKER_SECRET` → chave secreta (qualquer string, ex: `bemol-split-2024`)

### 3. Deploy

```bash
npm run deploy
```

Ou conecte o repositório ao Cloudflare Pages/Workers para deploy automático a cada push.

## Endpoint

```
POST https://gerar-carta-split.<seu-subdominio>.workers.dev/gerar-carta
Header: X-Worker-Secret: <WORKER_SECRET>
Body: { "card_id": "1234567890" }
```

## Configuração no Pipefy iPaaS

- **Trigger:** Campo "Data Emissão da Carta" atualizado
- **Action:** Fazer requisição HTTP
  - Method: `POST`
  - URL: `https://gerar-carta-split.<seu-subdominio>.workers.dev/gerar-carta`
  - Authentication: API Key
    - Chave: `X-Worker-Secret`
    - Valor: `<WORKER_SECRET>`
  - Body: `{"card_id": "{{card.id}}"}`

## Como atualizar o modelo Word

O arquivo `src/CARTA_DE_AUTORIZAÇÃO_-_AUTOMAÇÃO.docx` é o modelo original.
Quando precisar atualizar o layout da carta:

1. Edite o arquivo `.docx`
2. Gere o novo base64:
   ```bash
   base64 -w0 "src/CARTA_DE_AUTORIZAÇÃO_-_AUTOMAÇÃO.docx"
   ```
3. Substitua o valor de `DOCX_BASE64` no início do `src/worker.js`
4. Faça `git push` — o Cloudflare faz deploy automático
