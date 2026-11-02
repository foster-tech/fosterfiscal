CREATE TABLE IF NOT EXISTS dgii_ecf_submissions (
  id uuid PRIMARY KEY,
  environment text NOT NULL CHECK (environment = 'testecf'),
  issuer_rnc varchar(11) NOT NULL,
  encf varchar(13) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  input_hash char(64) NOT NULL,
  xml_hash char(64) NOT NULL,
  signed_xml_ciphertext bytea NOT NULL,
  signed_xml_iv bytea NOT NULL,
  signed_xml_auth_tag bytea NOT NULL,
  status varchar(32) NOT NULL,
  track_id varchar(200),
  reception_http_status integer,
  dgii_status_code integer,
  dgii_status_text varchar(100),
  sequence_used boolean,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostic jsonb,
  submitted_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT dgii_ecf_submissions_environment_document_unique
    UNIQUE (environment, issuer_rnc, encf),
  CONSTRAINT dgii_ecf_submissions_environment_idempotency_unique
    UNIQUE (environment, idempotency_key)
);

CREATE INDEX IF NOT EXISTS dgii_ecf_submissions_track_id_idx
  ON dgii_ecf_submissions (track_id)
  WHERE track_id IS NOT NULL;

COMMENT ON COLUMN dgii_ecf_submissions.signed_xml_ciphertext IS
  'XML assinado cifrado na aplicacao com AES-256-GCM; nao e conteudo publico';
