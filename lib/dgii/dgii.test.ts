import assert from "node:assert/strict";
import { createPrivateKey, webcrypto } from "node:crypto";
import test from "node:test";

import { X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";

import { sanitizeDgiiResponse } from "./authentication";
import { signSeedXml, validateSeedXml } from "./xml-signature";

cryptoProvider.set(webcrypto as unknown as Crypto);

test("aceita uma semilla XML valida", () => {
  assert.doesNotThrow(() =>
    validateSeedXml(
      '<?xml version="1.0" encoding="utf-8"?><SemillaModel><valor>123</valor><fecha>2026-10-15</fecha></SemillaModel>',
    ),
  );
});

test("rejeita XML com DTD antes da assinatura", () => {
  assert.throws(
    () =>
      validateSeedXml(
        '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><SemillaModel><valor>&secret;</valor><fecha>2026-10-15</fecha></SemillaModel>',
      ),
    /DTD|ENTITY/,
  );
});

test("rejeita resposta que nao seja SemillaModel", () => {
  assert.throws(
    () => validateSeedXml("<html><valor>123</valor><fecha>x</fecha></html>"),
    /SemillaModel/,
  );
});

test("remove tokens e material de certificado de diagnosticos JSON", () => {
  const sanitized = sanitizeDgiiResponse(
    JSON.stringify({
      message: "contribuinte nao habilitado",
      token: "segredo",
      certificate: "MI" + "A".repeat(200),
      nested: { password: "senha" },
    }),
  );

  assert.match(sanitized, /contribuinte nao habilitado/);
  assert.doesNotMatch(sanitized, /segredo|MIA{20}|senha/);
  assert.match(sanitized, /REDACTED/);
});

test("remove token de diagnosticos XML, inclusive com namespace", () => {
  const sanitized = sanitizeDgiiResponse(
    "<respuesta><ns:token>valor-secreto</ns:token><mensaje>rechazado</mensaje></respuesta>",
  );

  assert.doesNotMatch(sanitized, /valor-secreto/);
  assert.match(sanitized, /rechazado/);
});

test("gera e verifica uma assinatura XML DGII com certificado efemero", async () => {
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  };
  const keys = (await webcrypto.subtle.generateKey(
    algorithm,
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=FosterFiscal Test",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 60_000),
    signingAlgorithm: algorithm,
    keys,
  });
  const privateKeyDer = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyDer),
    format: "der",
    type: "pkcs8",
  });

  const signed = signSeedXml(
    "<SemillaModel><valor>123</valor><fecha>2026-10-15</fecha></SemillaModel>",
    { privateKey, certificatePem: certificate.toString("pem") },
  );

  assert.match(signed, /<Signature\b/);
  assert.match(signed, /Algorithm="http:\/\/www.w3.org\/2001\/04\/xmldsig-more#rsa-sha256"/);
  assert.match(signed, /Algorithm="http:\/\/www.w3.org\/2001\/04\/xmlenc#sha256"/);
  assert.match(signed, /Reference URI=""/);
  assert.doesNotMatch(signed, /PRIVATE KEY/);
});
