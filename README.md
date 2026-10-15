# FosterFiscal — Fase 1

Projeto Next.js para verificar se uma função Node.js hospedada na Vercel consegue
acessar três serviços REST da Dirección General de Impuestos Internos (DGII) da
República Dominicana.

Esta fase é somente diagnóstica. O projeto **não envia faturas, não assina XML e
não realiza autenticação fiscal**.

## Requisitos

- Node.js 20.9 ou superior
- npm
- Uma conta e um projeto na Vercel para executar o teste a partir da
  infraestrutura da Vercel

## Instalação local

```bash
npm install
```

Crie `.env.local` a partir de `.env.example` e defina um token longo e aleatório:

```dotenv
DGII_TEST_TOKEN=seu-token-longo-e-aleatorio
```

Nunca faça commit de `.env.local`. Os arquivos `.env*` são ignorados pelo Git,
com exceção do modelo `.env.example`.

Inicie o projeto:

```bash
npm run dev
```

## Endpoint de diagnóstico

```text
GET /api/dgii/test
```

O token deve ser enviado exclusivamente no header `x-dgii-test-token`:

```bash
curl -H "x-dgii-test-token: SEU_TOKEN" \
  http://localhost:3000/api/dgii/test
```

Exemplo com PowerShell:

```powershell
$headers = @{ "x-dgii-test-token" = "SEU_TOKEN" }
Invoke-RestMethod -Uri "http://localhost:3000/api/dgii/test" -Headers $headers
```

Cada destino tem timeout independente de 12 segundos. Os três testes são
executados em paralelo. Uma resposta HTTP, inclusive 4xx ou 5xx, indica que o
servidor foi alcançado; o status retornado permanece disponível em `httpStatus`.
Timeout, DNS, TLS e outras falhas de transporte aparecem em `error`, sem expor
detalhes internos ou segredos.

O endpoint retorna:

- `timestamp`: instante UTC do teste;
- `environment`: valor de `VERCEL_ENV` (ou `NODE_ENV` localmente);
- `region`: valor de `VERCEL_REGION` (ou `local` fora da Vercel);
- `results`: alcance, status HTTP, duração e eventual erro de cada serviço.

O retorno usa `Cache-Control: no-store`. O endpoint também desabilita o cache do
Next.js e de cada chamada externa.

## Deploy na Vercel

1. Envie este repositório para o provedor Git de sua preferência.
2. Importe o repositório na Vercel como um novo projeto.
3. Em **Settings > Environment Variables**, crie `DGII_TEST_TOKEN` para os
   ambientes em que o diagnóstico será executado. Use um valor secreto longo e
   não o prefixe com `NEXT_PUBLIC_`.
4. Na mesma tela, mantenha habilitada a opção de exposição automática das
   variáveis de sistema da Vercel. Ela disponibiliza `VERCEL_ENV` e
   `VERCEL_REGION` em tempo de execução.
5. Faça o deploy.
6. Execute o teste contra a URL implantada:

```bash
curl -H "x-dgii-test-token: SEU_TOKEN" \
  https://SEU-PROJETO.vercel.app/api/dgii/test
```

Não coloque o token na query string, no corpo da URL, em logs ou em capturas de
tela. O código não registra o header nem o valor configurado.

## Região da função

A região inicial está em `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["iad1"]
}
```

Altere `iad1` para a região Vercel que deseja comparar e faça um novo deploy. O
campo `region` da resposta confirma a região que efetivamente executou a função.
Para comparar regiões com clareza, execute e salve o resultado de cada deploy
separadamente.

## Respostas de controle de acesso

- `401`: header ausente ou token inválido;
- `503`: `DGII_TEST_TOKEN` não configurado no ambiente;
- `200`: diagnóstico executado; consulte cada item de `results`, pois um ou mais
  destinos podem ter falhado.

## Limites desta fase

Não estão implementados: geração ou assinatura de XML e-CF, certificado `.p12`,
autenticação DGII, transmissão, TrackId, controle de e-NCF, PDF/QR Code,
armazenamento fiscal ou interface de proformas. Essas funcionalidades só devem
ser iniciadas após a análise de conectividade e o planejamento da certificação
oficial.
