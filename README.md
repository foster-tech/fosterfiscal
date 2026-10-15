# FosterFiscal — diagnóstico e autenticação DGII

Projeto Next.js para validar, a partir da Vercel, a conectividade e a autenticação
por certificado digital com o ambiente de testes (`testecf`) da Dirección General
de Impuestos Internos (DGII) da República Dominicana.

O projeto **não emite nem transmite notas fiscais**, não chama endpoints fiscais
de produção e não devolve o token de autenticação recebido da DGII.

## Requisitos

- Node.js 20.9 ou superior
- npm
- Certificado Viafirma PKCS#12 (`.p12`) e respectiva senha
- Uma conta e um projeto na Vercel para executar o teste a partir da
  infraestrutura da Vercel

## Instalação local

```bash
npm install
```

Crie `.env.local` a partir de `.env.example`:

```dotenv
DGII_TEST_TOKEN=seu-token-longo-e-aleatorio
DGII_CERT_P12_BASE64=conteudo-base64-do-p12
DGII_CERT_PASSWORD=senha-do-p12
```

Nunca faça commit de `.env.local`, do arquivo `.p12` ou de qualquer conteúdo
Base64 do certificado. Os arquivos `.env*` são ignorados pelo Git, exceto o
modelo `.env.example`.

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

## Teste de autenticação por certificado

```text
POST /api/dgii/auth/test
```

O endpoint executa somente este fluxo no `testecf`:

1. obtém a `semilla` da DGII;
2. abre o PKCS#12 apenas em memória e identifica o certificado correspondente à
   chave privada RSA;
3. remove whitespace estrutural, seguindo o comportamento
   `PreserveWhitespace=false` dos exemplos oficiais, e assina o XML com
   assinatura XML envelopada, C14N 1.0, RSA-SHA256 e digest SHA-256;
4. verifica localmente a criptografia, o perfil XMLDSig, a posição da assinatura
   e o conteúdo de `KeyInfo/X509Data`;
5. gera o Blob UTF-8, relê e verifica exatamente o XML final antes de enviar o
   mesmo Blob no campo multipart `xml` para `validarsemilla`;
6. informa se um token foi recebido, sem retornar seu valor.

Cada chamada à DGII tem timeout de 12 segundos. A resposta inclui ambiente,
região, etapa, status HTTP, duração e diagnóstico sanitizado. Certificado, chave
privada, senha, token de proteção e token de autenticação nunca são registrados
ou retornados.

Exemplo após o deploy:

```powershell
$token = Read-Host "DGII_TEST_TOKEN"
$resultado = Invoke-RestMethod `
  -Method Post `
  -Uri "https://fosterfiscal.vercel.app/api/dgii/auth/test" `
  -Headers @{ "x-dgii-test-token" = $token }
$resultado | ConvertTo-Json -Depth 8
```

### Converter o `.p12` em Base64 sem exibi-lo

Execute localmente no PowerShell, substituindo apenas o caminho:

```powershell
$certBytes = [System.IO.File]::ReadAllBytes("C:\caminho\certificado.p12")
$certBase64 = [Convert]::ToBase64String($certBytes)
Set-Clipboard -Value $certBase64
Remove-Variable certBytes, certBase64
```

O conteúdo fica na área de transferência, sem ser impresso no terminal. Cole-o
diretamente como valor de `DGII_CERT_P12_BASE64` na Vercel e depois limpe a área
de transferência com `Set-Clipboard -Value ""`.

## Deploy na Vercel

1. Envie este repositório para o provedor Git de sua preferência.
2. Importe o repositório na Vercel como um novo projeto.
3. Em **Settings > Environment Variables**, crie `DGII_TEST_TOKEN`,
   `DGII_CERT_P12_BASE64` e `DGII_CERT_PASSWORD` para os ambientes em que os
   testes serão executados. Não use o prefixo `NEXT_PUBLIC_`.
4. Na mesma tela, mantenha habilitada a opção de exposição automática das
   variáveis de sistema da Vercel. Ela disponibiliza `VERCEL_ENV` e
   `VERCEL_REGION` em tempo de execução.
5. Faça um novo deploy depois de criar ou alterar qualquer variável.
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

No teste de autenticação, `503` indica configuração ausente ou inválida, `502`
indica timeout, falha de rede, rejeição da DGII ou resposta não reconhecida, e
`500` indica falha interna de assinatura/processamento. Uma rejeição na etapa
`validate_seed` preserva o status HTTP e uma mensagem sanitizada da DGII. Isso
permite identificar certificado inválido, contribuinte não habilitado ou
exigência de certificação sem expor segredos. O acesso ao Facturador Gratuito não
é tratado como autorização para integração própria.

O campo `diagnostic.category` diferencia `cryptographic_failure` (falha local),
`cryptographic_rejection` (assinatura verificada localmente, mas rejeitada pela
DGII), `format_incompatible` e `certificate_rejected`. O bloco `verification`
indica se o perfil, a assinatura local e o payload efetivamente enviado foram
verificados, além da correspondência e validade temporal do par
certificado/chave, sem retornar XML, certificado ou impressões digitais. Quando
a DGII rejeita uma assinatura que passou por todas as verificações locais,
`possibleCertificatePolicyRejection` sinaliza uma possível restrição de tipo,
habilitação ou uso do certificado; isso não substitui a confirmação pela DGII.

## Validação local

```bash
npm run typecheck
npm test
npm run build
npm audit
```

## Referências oficiais

- [Documentação sobre e-CF — DGII](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Paginas/documentacionSobreE-CF.aspx)
- [Descrição Técnica dos Serviços DGII](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Informe%20y%20Descripci%C3%B3n%20T%C3%A9cnica/Descripcion%20Tecnica%20Servicios%20DGII.pdf)
- [Instructivo oficial de assinatura de e-CF](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Instructivos%20sobre%20Facturaci%C3%B3n%20Electr%C3%B3nica/Firmado%20de%20e-CF.pdf)

## Limites desta fase

Continuam não implementados: geração ou transmissão de e-CF, endpoints fiscais
de produção, TrackId, controle de e-NCF, PDF/QR Code, armazenamento fiscal e
interface de proformas. A integração própria depende da habilitação e da
certificação oficial da DGII.
