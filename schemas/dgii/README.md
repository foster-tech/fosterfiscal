# DGII e-CF schemas

`ecf-31-v1.0.xsd` is an unmodified copy of the official DGII schema published
as **e-CF 31 v.1.0**, marked as modified on 2025-10-16.

- Source: https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Documentaci%C3%B3n%20T%C3%A9cnica%20(XSD)/e-CF%2031%20v.1.0.xsd
- SHA-256: `6f2909a93d84919518d2ae3c77fead4b35c3e8c95996b8af67b0040c2e2be298`
- XSD dependencies: none (`xs:include` and `xs:import` are not present).

The runtime verifies the checksum before using the schema.

## Documented compatibility patch

The official file declares
`<xs:simpleType name=" IndicadorServicioTodoIncluidoType">` with a leading
space, while its element reference uses `IndicadorServicioTodoIncluidoType`.
That is not a valid XML Schema `NCName`, and libxml2 refuses to compile it.
The checked-in source remains byte-for-byte unchanged; after checksum
verification, the runtime removes that single leading space in memory. It
fails closed if the exact source occurrence changes.
