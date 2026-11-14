# Contrato SaaS — facturación recurrente (decisión de diseño, NO implementada)

**Estado: aprobado únicamente a nivel de diseño (9-nov-2026). Nada de esto está programado ni activado.**

## Decisión

En una etapa futura, ETNARA Care tendrá **cobros automáticos mensuales**, con estas condiciones:

1. **Consentimiento expreso.** Ningún cobro automático empieza sin que la representante designada de la agencia
   acepte expresamente el precio, la fecha del primer cargo y la renovación mensual (cláusulas 5.2 y 5.4 y
   Anexo A del Contrato General). Aceptar el Contrato General o una Orden de Suscripción NO equivale a ese
   consentimiento.
2. **Posibilidad de cancelar la renovación.** La agencia podrá cancelar la renovación antes del siguiente
   período, sin permanencia ni penalidad, y conservará el acceso hasta el final del período pagado (cláusula 14.2).
3. **Precio individual.** El precio sale de la Orden de Suscripción de cada agencia, con aprobación comercial y
   jurídica de ese texto exacto. No existe un precio predeterminado.
4. **Cambios de precio.** Requieren aviso previo y nueva aceptación cuando la ley lo exija (cláusula 5.6).
5. **Fin del mes gratuito (Agencias Fundadoras).** Si la agencia no contrata un plan de pago, no se presume
   obligación de pago ni se cobra (cláusula 5.5).

## Lo que hoy garantiza el sistema (migración 153)

- La base rechaza cualquier Orden con `automaticCharges`, `automaticRenewal` o `billingActivated` en verdadero,
  o sin `chargesRequireExpressAcceptance`. Ni el superusuario puede guardarla.
- No existe código de cobro, pasarela de pago, tarea programada ni suscripción.

## Antes de implementarla (cada punto con autorización escrita)

- Texto final del contrato y de la Orden aprobado por el abogado.
- Diseño del consentimiento de cobro como evidencia propia (quién, cuándo, precio, huella), separado de la
  aceptación del contrato.
- Pantalla para cancelar la renovación y constancia de la cancelación.
- Elección del procesador de pagos y revisión de seguridad y privacidad.
- Migración nueva que sustituya de forma explícita y revisada las salvaguardas actuales.
