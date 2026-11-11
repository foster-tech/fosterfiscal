import { authenticateDgii } from "../lib/dgii/authentication";

const issuerRnc = process.argv[2] ?? "132071506";
const start = Number(process.argv[3] ?? "1");
const count = Number(process.argv[4] ?? "5");

if (!/^\d{9,11}$/.test(issuerRnc)) {
  throw new Error("RNC emissor invalido");
}
if (!Number.isSafeInteger(start) || start < 1) {
  throw new Error("Sequencia inicial invalida");
}
if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
  throw new Error("Quantidade deve estar entre 1 e 100");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel ${name} ausente`);
  return value;
}

async function main(): Promise<void> {
  const session = await authenticateDgii({
    p12Base64: requiredEnvironment("DGII_CERT_P12_BASE64"),
    certificatePassword: process.env.DGII_CERT_PASSWORD ?? "",
    environment: "ecf",
  });

  const queries = [];
  for (let offset = 0; offset < count; offset += 1) {
    const sequence = start + offset;
    const encf = `E31${String(sequence).padStart(10, "0")}`;
    const url = new URL(
      "https://ecf.dgii.gov.do/ecf/consultaestado/api/Consultas/Estado",
    );
    url.searchParams.set("RncEmisor", issuerRnc);
    url.searchParams.set("NcfElectronico", encf);

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${session.token}`,
      },
      cache: "no-store",
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = { message: "A DGII respondeu sem JSON" };
    }
    queries.push({ encf, httpStatus: response.status, response: body });
  }

  console.log(JSON.stringify({
    success: true,
    issuerRnc,
    environment: "ecf",
    authenticated: true,
    queries,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
  }));
  process.exitCode = 1;
});
