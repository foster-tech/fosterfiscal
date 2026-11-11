import {
  authenticateDgii,
  DgiiAuthenticationError,
} from "../lib/dgii/authentication";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Variavel ${name} ausente`);
  return value;
}

async function main(): Promise<void> {
  const { token: _token, ...safeResult } = await authenticateDgii({
    p12Base64: requiredEnvironment("DGII_CERT_P12_BASE64"),
    certificatePassword: process.env.DGII_CERT_PASSWORD ?? "",
    environment: "certecf",
    requestTimeoutMs: 30_000,
  });
  console.log(JSON.stringify(safeResult, null, 2));
}

main().catch((error: unknown) => {
  const authenticationError = error instanceof DgiiAuthenticationError ? error : null;
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
    stage: authenticationError?.stage ?? null,
    category: authenticationError?.category ?? null,
    httpStatus: authenticationError?.httpStatus ?? null,
    steps: authenticationError?.steps ?? [],
  }, null, 2));
  process.exitCode = 1;
});
