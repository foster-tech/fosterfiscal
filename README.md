# FosterFiscal — integração DGII em `testecf`

Projeto Next.js para validar, a partir da Vercel, a conectividade e a autenticação
por certificado digital com o ambiente de testes (`testecf`) da Dirección General
de Impuestos Internos (DGII) da República Dominicana.

O projeto não chama endpoints fiscais de produção e não devolve o token de
autenticação recebido da DGII. O envio de e-CF existe somente para `testecf`, é
desabilitado por padrão e depende de confirmação prévia da habilitação fiscal.

Além dos diagnósticos, o projeto prepara localmente uma Factura de Crédito Fiscal
Electrónica tipo 31: valida dados e totais, gera XML, valida no XSD oficial e
assina. Também implementa recepção e consulta de estado em `testecf`, com
persistência, idempotência e reconciliação; nenhuma transmissão foi executada
durante a implementação ou nos testes automatizados.

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
DATABASE_URL=postgresql://usuario:senha@host/banco?sslmode=require
DGII_STORAGE_ENCRYPTION_KEY_BASE64=chave-aleatoria-de-32-bytes-em-base64
DGII_RECEIVER_RNC=seu-rnc-de-9-ou-11-digitos
DGII_ENABLE_TEST_SUBMISSION=false
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
   `DGII_CERT_P12_BASE64`, `DGII_CERT_PASSWORD`, `DATABASE_URL` e
   `DGII_STORAGE_ENCRYPTION_KEY_BASE64` e `DGII_RECEIVER_RNC`. Mantenha
   `DGII_ENABLE_TEST_SUBMISSION=false` ou ausente até o primeiro teste ser
   expressamente autorizado. Não use o prefixo `NEXT_PUBLIC_`.
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
    "address": "C. Maximo Avilés Blonda #12, Julieta Morales, IM Plaza 2B, Santo Domingo, D.N.",
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
O original possui 123.019 bytes, codificação UTF-8 sem BOM e terminações CRLF.
Ele é autocontido e não possui `xs:include` ou `xs:import`. O arquivo
`.gitattributes` marca os XSDs como `binary` (incluindo `-text`), impedindo que
o Git converta CRLF para LF no blob usado pelo deploy.

O arquivo oficial contém um espaço inicial inválido na declaração do tipo
`IndicadorServicioTodoIncluidoType`. A cópia oficial é preservada sem alterações;
O SHA-256 é calculado diretamente sobre o `Buffer` original, antes da
decodificação ou de qualquer transformação. Depois de conferir o checksum, o
runtime remove somente esse espaço em memória
para permitir que o libxml2 compile o XSD. A correção falha de modo seguro se o
arquivo oficial mudar.

`xmllint-wasm` executa libxml2 em WebAssembly e não depende de binários nativos.
O `next.config.ts` mantém o pacote como dependência externa do servidor e inclui
o XSD, o carregador, o worker e o arquivo WASM no rastreamento da função da
Vercel. No runtime serverless, esses três recursos do pacote são verificados e
copiados para um diretório temporário privado antes da carga. Isso mantém o
worker e o WASM adjacentes, como a biblioteca exige, independentemente da
disposição feita pelo bundle da função.

Se a inicialização falhar, `diagnostic.runtime` retorna apenas `code`,
`component`, uma mensagem sanitizada e, quando disponível, o código de sistema.
Os códigos distinguem falha ao carregar o XSD, resolver o pacote, localizar ou
preparar os recursos, iniciar o worker e carregar o WASM. Caminhos absolutos,
XML e sequências longas de dados são removidos; nada é registrado no console.

## Contrato oficial de recepção e consulta

A implementação usa URLs constantes no servidor; nenhuma URL ou ambiente pode
ser fornecido pelo cliente. A **Descrição Técnica Serviços DGII**, publicada na
página oficial como modificada em 29/05/2026, define:

| Serviço | TesteCF (pré-certificação) | CerteCF (certificação) | eCF (produção) |
| --- | --- | --- | --- |
| Recepção | `https://ecf.dgii.gov.do/testecf/recepcion` | `https://ecf.dgii.gov.do/certecf/recepcion` | `https://ecf.dgii.gov.do/ecf/recepcion` |
| Consulta por TrackId | `https://ecf.dgii.gov.do/testecf/consultaresultado` | `https://ecf.dgii.gov.do/certecf/consultaresultado` | `https://ecf.dgii.gov.do/ecf/consultaresultado` |

Somente as URLs `testecf` da primeira coluna estão compiladas nesta fase. A
recepção é `POST /api/facturaselectronicas`, com token de sessão no header
`Authorization: bearer ...`, `Accept: application/json` e multipart no campo
`xml`, MIME `text/xml`. O nome segue `RNC+e-NCF.xml`. A resposta contém
`trackId`, `error` e `mensaje`.

A consulta é `GET /api/consultas/estado?trackid=...`, também autenticada. Os
códigos oficiais são 0 `No encontrado`, 1 `Aceptado`, 2 `Rechazado`, 3
`En Proceso` e 4 `Aceptado Condicional`. O sistema preserva código, texto,
mensagens e `secuenciaUtilizada`, além de normalizar os estados. Um TrackId ou
HTTP 200 de recepção significa somente que houve recepção; a validade fiscal
depende de uma consulta posterior com estado aceito ou aceito condicional.

Para reconciliar timeout de recepção, a documentação oferece em `testecf`
`GET https://ecf.dgii.gov.do/testecf/consultatrackids/api/trackids/consulta`
com `rncemisor` e `encf`. Ela pode devolver múltiplos TrackIds e exige que o
usuário autenticado esteja delegado para o emissor. A edição atual da
documentação lista esse serviço para TesteCF e produção, mas não publica uma URL
de CerteCF; o projeto não inventa uma.

## Persistência e idempotência

Use um PostgreSQL acessível pela Vercel (por exemplo, uma integração de banco do
Marketplace que forneça `DATABASE_URL`). Execute uma vez a migração:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f .\migrations\001_dgii_ecf_submissions.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f .\migrations\002_dgii_inbound_services.sql
```

A tabela possui restrições únicas para `(environment, issuer_rnc, encf)` e
`(environment, idempotency_key)`. O primeiro `INSERT ... ON CONFLICT DO NOTHING`
é a disputa atômica entre requisições concorrentes. A mesma chave com entrada
diferente retorna HTTP 409; uma repetição legítima devolve o registro existente
e nunca repete automaticamente o POST fiscal.

O XML assinado original é cifrado antes de ser persistido com AES-256-GCM. Gere
a chave localmente e copie-a sem exibi-la no terminal:

```powershell
$storageKeyBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$storageKeyBase64 = [Convert]::ToBase64String($storageKeyBytes)
Set-Clipboard -Value $storageKeyBase64
[System.Security.Cryptography.CryptographicOperations]::ZeroMemory($storageKeyBytes)
Remove-Variable storageKeyBytes, storageKeyBase64
```

Cole o valor em `DGII_STORAGE_ENCRYPTION_KEY_BASE64` na Vercel e limpe a área de
transferência com `Set-Clipboard -Value ""`. Faça backup seguro dessa chave:
perdê-la impede recuperar os XMLs já armazenados; trocá-la requer uma migração
de chaves. O banco e essa variável não podem ser públicos.

## Serviços públicos Emissor-Receptor

O projeto expõe os recursos padronizados pela **Descrição Técnica Serviços
Emissores Eletrônicos**:

```text
GET  /fe/autenticacion/api/semilla
POST /fe/autenticacion/api/validacioncertificado
POST /fe/recepcion/api/ecf
POST /fe/aprobacioncomercial/api/ecf
```

`semilla` gera um valor aleatório persistido como hash, válido por cinco
minutos e de uso único. `validacioncertificado` recebe o XML assinado no campo
multipart `xml`, valida XMLDSig RSA-SHA256 e devolve um Bearer token RS256 com
validade de uma hora. Os endpoints de documentos exigem esse token e vinculam o
certificado do XML à identidade que o obteve.

`recepcion` recebe e-CF no campo multipart `xml` e responde com ARECF assinado.
As respostas distinguem recebido (`Estado=0`), erro de especificação ou
assinatura, duplicidade e RNC comprador incorreto. `aprobacioncomercial` valida e armazena o ACECF e
responde HTTP 200 ou 400, conforme o contrato oficial. XMLs recebidos e ARECFs
são cifrados com AES-256-GCM antes da persistência.

Configure `DGII_RECEIVER_RNC` com o RNC que aparecerá como comprador dos e-CF
recebidos e como emissor original nos ACECFs recebidos. A migração `002` deve
ser executada antes do deploy. No Portal de Certificação, use apenas o host nos
três campos de URL, pois o portal acrescenta o protocolo e os caminhos:

```text
fosterfiscal.vercel.app
```

Essas rotas são públicas por definição do protocolo e não usam
`DGII_TEST_TOKEN`; a proteção é feita pelo fluxo semilla/certificado/Bearer.

## Envio E31 em TesteCF

```text
POST /api/dgii/ecf/send-test
```

O endpoint exige `x-dgii-test-token`, `Idempotency-Key` e JSON. Internamente ele
reutiliza o mesmo fluxo de validação, cálculo, geração, XSD, assinatura e
verificação de `prepare-test`; autentica com a semilla e transmite exatamente os
bytes UTF-8 validados no multipart oficial. Não há chamada HTTP interna entre as
rotas.

Antes de habilitar o envio, confirme com a DGII:

- que o RNC `132071506` está habilitado no conjunto de pré-certificação;
- que o titular do certificado está delegado para esse emissor;
- que `E310000000001` pertence à faixa E31 atribuída para o teste e ainda não foi
  utilizado;
- qual é a data de vencimento indicada pelo conjunto atribuído. A data informada
  anteriormente, `31-12-2027`, precisa ser reconfirmada: a orientação oficial
  atual sobre pré-certificação informa vencimento geral em `31/12/2028`;
- que o comprador `133286556` e o cenário tributário fazem parte dos dados do
  caso de teste atribuído.

A preparação local e a autenticação bem-sucedida não comprovam nenhum desses
itens. O acesso ao Facturador Gratuito também não autoriza, por si só, integração
direta. O processo oficial exige baixar do Portal de Certificação o Set Prueba
e-CF fornecido pela DGII e gerar os XMLs com os mesmos campos e na mesma ordem;
em pré-certificação, os tipos 31 e 33–47 aceitos precedem os testes do tipo 32.
Somente depois da confirmação, altere na Vercel:

```dotenv
DGII_ENABLE_TEST_SUBMISSION=true
```

Faça novo deploy e envie **uma única vez**, usando uma chave nova que deverá ser
guardada com o resultado:

```powershell
$token = Read-Host "DGII_TEST_TOKEN"
$idempotencyKey = [guid]::NewGuid().ToString()
$envio = Invoke-RestMethod `
  -Method Post `
  -Uri "https://fosterfiscal.vercel.app/api/dgii/ecf/send-test" `
  -Headers @{
    "x-dgii-test-token" = $token
    "Idempotency-Key" = $idempotencyKey
  } `
  -ContentType "application/json" `
  -InFile ".\ecf31-input.json"
$envio | ConvertTo-Json -Depth 10
$submissionId = $envio.id
```

Não gere outra chave para repetir o mesmo pedido. Reutilize a chave original;
isso retorna o registro existente sem retransmitir.

## Consulta e acompanhamento

```text
GET /api/dgii/ecf/status-test?id=<UUID interno>
```

Uma consulta isolada:

```powershell
$estado = Invoke-RestMethod `
  -Method Get `
  -Uri "https://fosterfiscal.vercel.app/api/dgii/ecf/status-test?id=$submissionId" `
  -Headers @{ "x-dgii-test-token" = $token }
$estado | ConvertTo-Json -Depth 10
```

Polling limitado no cliente, sem manter uma função serverless aberta:

```powershell
$terminal = @("accepted", "accepted_conditional", "rejected")
for ($attempt = 1; $attempt -le 10; $attempt++) {
  $estado = Invoke-RestMethod `
    -Method Get `
    -Uri "https://fosterfiscal.vercel.app/api/dgii/ecf/status-test?id=$submissionId" `
    -Headers @{ "x-dgii-test-token" = $token }
  Write-Host "Tentativa $attempt - estado: $($estado.status)"
  if ($terminal -contains $estado.status) { break }
  if ($attempt -lt 10) { Start-Sleep -Seconds 3 }
}
$estado | ConvertTo-Json -Depth 10
Remove-Variable token
```

Estados normalizados: `received`, `processing`, `accepted`,
`accepted_conditional`, `rejected`, `not_found`, `indeterminate`,
`communication_failure` e `authentication_failed`. Aceito condicional tem
validade segundo a tabela oficial, mas permanece distinto para revisão.

### Recuperação de resultado indeterminado

Se o POST sofrer timeout ou falha de rede depois de iniciado, o registro fica
`indeterminate`: a DGII pode ou não tê-lo recebido. Não repita o envio. Chame
`status-test` com o mesmo `id`; sem TrackId armazenado, o servidor autentica e
consulta oficialmente por RNC/e-NCF. Se houver exatamente um candidato, salva o
TrackId e consulta seu estado. Nenhum candidato mantém o resultado indeterminado
para nova consulta posterior; múltiplos candidatos exigem revisão manual. O
sistema deliberadamente não promete semântica “exactly once”.

## Validação local

```bash
npm run typecheck
npm test
npm run build
npm audit
```

Os testes de submissão usam transporte e repositório simulados; `npm test` e
`npm run build` não acessam a DGII nem o banco configurado.

## Referências oficiais

- [Documentação sobre e-CF — DGII](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Paginas/documentacionSobreE-CF.aspx)
- [Descrição Técnica dos Serviços DGII](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Informe%20y%20Descripci%C3%B3n%20T%C3%A9cnica/Descripcion%20Tecnica%20Servicios%20DGII.pdf)
- [Descrição Técnica dos Serviços Emissores Eletrônicos](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Informe%20y%20Descripci%C3%B3n%20T%C3%A9cnica/Descripcion%20Tecnica%20Emisores%20Electronicos.pdf)
- [Instructivo oficial de assinatura de e-CF](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Instructivos%20sobre%20Facturaci%C3%B3n%20Electr%C3%B3nica/Firmado%20de%20e-CF.pdf)
- [Formato e-CF v1.0 — modificado em 30/10/2025](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Formatos%20XML/Formato%20Comprobante%20Fiscal%20Electr%C3%B3nico%20(e-CF)%20V1.0.pdf)
- [XSD oficial e-CF 31 v1.0 — modificado em 16/10/2025](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Documentaci%C3%B3n%20T%C3%A9cnica%20(XSD)/e-CF%2031%20v.1.0.xsd)
- [Processo oficial de certificação — Set Prueba e-CF](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Documentaciones%20Proceso%20de%20Certificaci%C3%B3n%20FE/Proceso%20de%20Certificacio%CC%81n%20para%20ser%20Emisor%20Electro%CC%81nico.pdf)
- [DGII: ambientes de pré-certificação, certificação e produção](https://ayuda.dgii.gov.do/conversations/facturacin-electrnica/ca5366-qu-es-un-ambiente-de-pruebas-en-facturacin-electrnica/69aed7c32cd1411e40eb8340)

## Limites desta fase

Continuam não implementados: endpoints fiscais de produção, emissão comercial,
PDF/QR Code, interface de proformas e administração de faixas/e-NCF. A tabela
impede duplicidade local, mas não substitui a gestão fiscal completa de
sequências. Esta fase não envia automaticamente ao receptor e não transforma o
resultado de pré-certificação em autorização de produção.
