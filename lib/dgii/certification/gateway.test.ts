import assert from "node:assert/strict";
import test from "node:test";

import {
  CERTECF_COMMERCIAL_APPROVAL_ENDPOINT,
  CERTECF_RFCE_ENDPOINT,
  submitCommercialApprovalCertification,
  submitRfceCertification,
} from "./gateway";

test("envia RFCE no recurso oficial CerteCF e interpreta aceite", async () => {
  const xml = "<RFCE><Encabezado /></RFCE>";
  const result = await submitRfceCertification({
    xml,
    issuerRnc: "132071506",
    encf: "E320000000014",
    token: "not-returned",
  }, async (url, init) => {
    assert.equal(url, CERTECF_RFCE_ENDPOINT);
    assert.equal(init?.method, "POST");
    const body = Buffer.from(await (init?.body as Blob).arrayBuffer());
    const contentType = new Headers(init?.headers).get("content-type");
    assert.match(contentType ?? "", /^multipart\/form-data; boundary=/);
    assert.equal(
      new Headers(init?.headers).get("content-length"),
      String(body.length),
    );
    const multipart = body.toString("utf8");
    assert.match(multipart, /name="xml"; filename="132071506E320000000014\.xml"/);
    assert.match(multipart, /Content-Type: text\/xml/);
    assert.ok(multipart.includes(xml));
    assert.match(multipart, /--\r\n$/);
    return new Response(JSON.stringify({
      codigo: 1,
      estado: "Aceptado",
      mensajes: [],
      encf: "E320000000014",
      secuenciaUtilizada: false,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.equal(result.normalizedStatus, "accepted");
  assert.equal(result.encf, "E320000000014");
});

test("envia ACECF no recurso oficial e interpreta codigo 01", async () => {
  const xml = "<ACECF><DetalleAprobacionComercial /></ACECF>";
  const result = await submitCommercialApprovalCertification({
    xml,
    fileName: "132071506E310000000001.xml",
    token: "not-returned",
  }, async (url, init) => {
    assert.equal(url, CERTECF_COMMERCIAL_APPROVAL_ENDPOINT);
    assert.equal(init?.method, "POST");
    const body = Buffer.from(await (init?.body as Blob).arrayBuffer());
    const multipart = body.toString("utf8");
    assert.match(multipart, /name="xml"; filename="132071506E310000000001\.xml"/);
    assert.ok(multipart.includes(xml));
    return new Response(JSON.stringify({
      codigo: "01",
      estado: "Aprobacion Comercial Aprobada.",
      mensaje: [],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(result.accepted, true);
  assert.equal(result.code, "01");
});
