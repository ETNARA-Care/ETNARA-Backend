# ETNARA Tower — Fase 11.1: arquitectura del equipo tecnológico

Estado: propuesta de arquitectura, **sin agentes desplegados ni permisos concedidos**.

## Propósito
Centro de operaciones de ETNARA Care para diagnosticar incidentes, coordinar especialistas de IA y proponer cambios verificables. ETNARA Tower es una capa operativa integrada a la plataforma existente, no una base de datos paralela ni un reemplazo de los portales.

## Agentes y responsabilidades

| ID | Agente | Responsabilidad | Herramientas previstas |
|---|---|---|---|
| CTO | Coordinador tecnológico | Clasificar incidentes, delegar tareas, revisar evidencias y solicitar aprobaciones | Registro de incidentes y reportes |
| SWE | Software Engineer | Diagnóstico frontend/backend, pruebas, parches y propuestas de PR | GitHub lectura; escritura solo en rama de trabajo |
| SYS | Systems Engineer | Diagnóstico de infraestructura, DNS, despliegues y conectividad | Railway y Cloudflare inicialmente solo lectura |
| SRE | Site Reliability Engineer | Healthchecks, pruebas sintéticas, alertas, análisis de disponibilidad | Métricas, logs sanitizados y pruebas no destructivas |
| SEC | Cybersecurity Engineer | Revisión de permisos, aislamiento multi-tenant, secretos y seguridad de cambios | Auditoría de configuraciones y resultados de pruebas |

## Principios obligatorios
1. **No autonomía irrestricta.** Diagnósticos y lectura pueden automatizarse; modificaciones de producción, DNS, permisos, secretos, migraciones y rollback requieren autorización humana explícita.
2. **Separación multi-tenant.** Ningún agente puede cruzar organizaciones ni evadir RLS; cada operación utiliza identidad de servicio con permisos mínimos y alcance auditable.
3. **No credenciales en prompts, informes ni logs.** Solo referencias opacas a secretos administrados por infraestructura.
4. **Acciones trazables.** Registrar quién/qué agente propuso o ejecutó cada acción, evidencia, organización/entorno, aprobación, resultado y enlace al PR/deployment.
5. **Evidencia antes de resolución.** Un incidente solo se declara resuelto tras pruebas y verificación operativa.
6. **Protección de datos sensibles.** Minimizar y sanitizar registros antes de que un modelo los procese.
7. **Fallos seguros.** Ante error de permisos, modelo o integración, no ejecutar acciones de escritura.

## Flujo de incidentes
Detectar (SRE) → clasificar (CTO) → investigar (SWE/SYS) → revisar riesgo (SEC) → proponer solución y pruebas (SWE) → autorización si aplica (humano) → ejecutar mediante CI/CD → verificar (SRE) → cerrar (CTO).

## Contrato mínimo de tareas (diseño)
- `incident_id`, `agent_id`, `task_type`, `environment`, `organization_scope` (cuando aplique)
- `status`: queued | running | needs_approval | completed | failed
- `evidence_refs`, `proposed_actions`, `risk_level`, `approval_ref`, `audit_events`
- No guardar secretos ni datos clínicos en este contrato.

## Implementación incremental
- **11.1**: catálogo de agentes, permisos, arquitectura y criterios de aceptación (este documento).
- **11.2**: adaptadores de lectura de GitHub/Railway/Cloudflare y registro de auditoría.
- **11.3**: healthchecks y pruebas sintéticas seguras de cada portal; alertas y aprobaciones.
- **11.4**: interfaz ETNARA Tower 3D conectada a datos reales; el 3D nunca será requisito para responder a incidentes.

## Criterios de aceptación de 11.1
- Cinco agentes documentados con funciones no superpuestas.
- Matriz de permisos y controles de aprobación definidos.
- Flujo de incidentes y contrato de tareas definidos.
- Ningún cambio a autenticación, tablas clínicas, RLS ni despliegue de producción.
- Revisión de arquitectura en PR antes de fusionar.

## Fuera de alcance de 11.1
Ejecutar modelos, crear cuentas de servicio, monitorizar 24/7, modificar producción, construir la torre 3D o afirmar que ya existen agentes autónomos.
