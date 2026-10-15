# FosterFiscal — diagnóstico e autenticação DGII

Projeto Next.js para validar, a partir da Vercel, a conectividade e a autenticação
por certificado digital com o ambiente de testes (`testecf`) da Dirección General
de Impuestos Internos (DGII) da República Dominicana.

O projeto **não emite nem transmite notas fiscais**, não chama endpoints fiscais
de produção e não devolve o token de autenticação recebido da DGII.

Além dos diagnósticos, o projeto prepara localmente uma Factura de Crédito Fiscal
Electrónica tipo 31: valida dados e totais, gera XML, valida no XSD oficial e
assina. O documento não é enviado à DGII.

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

## Preparação local de e-CF E31

```text
POST /api/dgii/ecf/prepare-test
```

O endpoint usa o mesmo header `x-dgii-test-token` e as mesmas variáveis do
certificado. O fluxo é: validação do JSON, cálculo decimal, geração ordenada do
XML, carregamento do certificado, assinatura e-CF, validação XSD real com
libxml2/WebAssembly e verificação criptográfica final. Não existe chamada à DGII.

O exemplo em `examples/ecf31.prepare-test.example.json` é deliberadamente um
modelo incompleto: os identificadores `REPLACE_...` e as datas `DD-MM-AAAA` não
representam RNC ou sequências autorizadas. Antes de executar, copie o arquivo e
substitua-os por dados destinados ao `testecf`:

- e-NCF E31 de uma faixa de testes autorizada pela DGII;
- data de vencimento dessa faixa;
- RNC e razão social do emissor habilitado no processo de testes;
- RNC e razão social do comprador de teste;
- data de emissão válida;
- tratamento tributário real de cada item (`billingIndicator`);
- tipo de receita e forma de pagamento aplicáveis.

A documentação pública consultada não fornece uma combinação de RNC e e-NCF
autorizada para executar este teste. Esses valores precisam vir da habilitação ou
faixa de testes da empresa na DGII; o projeto não cria nem reserva sequências.

Valores monetários devem ser strings decimais, sem separadores de milhar. Nesta
fase são suportados itens sem descontos, recargos, retenções ou impostos
adicionais, com indicadores 1 (18%), 2 (16%), 3 (0%) ou 4 (exento). O campo
`amountsIncludeTax` deve ser informado explicitamente. `paymentType` suporta 1
(contado) e 2 (crédito); crédito exige `paymentDueDate`.
`signatureDateTime` é opcional e, quando omitido, é gerado em GMT-4. Informe-o no
formato `dd-MM-AAAA HH:mm:ss` quando precisar reproduzir exatamente o mesmo XML.

Exemplo estrutural de entrada:

```json
{
  "document": {
    "eNCF": "REPLACE_WITH_DGII_TEST_ENCF",
    "sequenceExpirationDate": "DD-MM-AAAA",
    "incomeType": "01",
    "paymentType": 1,
    "amountsIncludeTax": false
  },
  "issuer": {
    "rnc": "REPLACE_WITH_AUTHORIZED_TEST_RNC",
    "legalName": "REPLACE WITH THE REGISTERED ISSUER NAME",
    "address": "REPLACE WITH THE ISSUER ADDRESS",
    "issueDate": "DD-MM-AAAA"
  },
  "buyer": {
    "rnc": "REPLACE_WITH_TEST_BUYER_RNC",
    "legalName": "REPLACE WITH THE BUYER NAME"
  },
  "items": [{
    "name": "TEST SERVICE DESCRIPTION",
    "kind": 2,
    "billingIndicator": 1,
    "quantity": "1.00",
    "unitPrice": "100.0000"
  }],
  "totals": {
    "taxableAmount": "100.00",
    "exemptAmount": "0.00",
    "itbis": "18.00",
    "total": "118.00"
  }
}
```

Execute o diagnóstico sem retornar o XML:

```powershell
$token = Read-Host "DGII_TEST_TOKEN"
$resultado = Invoke-RestMethod `
  -Method Post `
  -Uri "https://fosterfiscal.vercel.app/api/dgii/ecf/prepare-test" `
  -Headers @{ "x-dgii-test-token" = $token } `
  -ContentType "application/json" `
  -InFile ".\ecf31-input.json"
$resultado | ConvertTo-Json -Depth 10
```

Baixe diretamente o XML assinado, sem armazenamento público:

```powershell
Invoke-WebRequest `
  -Method Post `
  -Uri "https://fosterfiscal.vercel.app/api/dgii/ecf/prepare-test?download=1" `
  -Headers @{ "x-dgii-test-token" = $token } `
  -ContentType "application/json" `
  -InFile ".\ecf31-input.json" `
  -OutFile ".\ecf31-test-signed.xml"
Remove-Variable token
```

A resposta de download usa `Cache-Control: no-store`, exige autenticação e é
gerada novamente em memória. O XML não é gravado pelo servidor nem registrado
em logs.

### XSD e compatibilidade Vercel

O schema incorporado é o **e-CF 31 v1.0**, modificado pela DGII em 16/10/2025,
com SHA-256
`6f2909a93d84919518d2ae3c77fead4b35c3e8c95996b8af67b0040c2e2be298`.
Ele é autocontido e não possui `xs:include` ou `xs:import`.

O arquivo oficial contém um espaço inicial inválido na declaração do tipo
`IndicadorServicioTodoIncluidoType`. A cópia oficial é preservada sem alterações;
depois de conferir seu checksum, o runtime remove somente esse espaço em memória
para permitir que o libxml2 compile o XSD. A correção falha de modo seguro se o
arquivo oficial mudar.

`xmllint-wasm` executa libxml2 em WebAssembly e não depende de binários nativos.
O `next.config.ts` mantém o pacote como dependência externa do servidor e inclui
o XSD, o worker e o arquivo WASM no rastreamento da função da Vercel.

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
- [Formato e-CF v1.0 — modificado em 30/10/2025](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Formatos%20XML/Formato%20Comprobante%20Fiscal%20Electr%C3%B3nico%20(e-CF)%20V1.0.pdf)
- [XSD oficial e-CF 31 v1.0 — modificado em 16/10/2025](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Documentaci%C3%B3n%20T%C3%A9cnica%20(XSD)/e-CF%2031%20v.1.0.xsd)

## Limites desta fase

Continuam não implementados: transmissão ou emissão de e-CF, endpoints fiscais
de produção, TrackId, reserva/controle de e-NCF, PDF/QR Code, armazenamento
fiscal e interface de proformas. A preparação local não comprova autorização da
sequência, situação cadastral do RNC ou habilitação do emissor; essas verificações
dependem da DGII e não são simuladas pelo sistema.
