# Fase 10.1 — Administración por establecimiento

## Objetivo

Extender el aislamiento multi-organización de Fase 10.0 al nivel de establecimiento (`locations`) sin duplicar los módulos existentes de Workforce, Care, Compliance o agentes.

## Jerarquía de acceso

- Organización: tenant principal y cliente B2B de ETNARA.
- Establecimiento: unidad operativa perteneciente a una sola organización.
- Administrador de organización: puede administrar todos los establecimientos de su organización.
- Administrador de establecimiento: acceso limitado a los establecimientos que le hayan sido asignados.
- Personal: pertenece a la organización y puede asignarse a uno o más establecimientos autorizados.
- Residente/paciente: pertenece a la organización y se adscribe a un establecimiento operativo.

## Regla de seguridad

El `organization_id` continúa siendo la frontera primaria de tenant. `location_id` añade una segunda frontera de autorización. Nunca se confiará solamente en filtros del frontend: el backend y PostgreSQL/RLS deben impedir acceso cruzado.

Un administrador de un establecimiento no puede leer ni modificar personal, residentes, documentos, turnos o datos operativos de otro establecimiento salvo que tenga una asignación explícita a ambos.

## Implementación incremental

### 10.1A — Base de datos y autorización

1. Crear relación de usuarios administrativos con establecimientos.
2. Añadir `location_id` a residentes de forma compatible con datos existentes.
3. Crear relación de personal con establecimientos, permitiendo más de uno cuando corresponda.
4. Índices, claves foráneas compuestas y RLS/funciones de autorización por establecimiento.
5. Mantener acceso organization-wide para administradores de organización.
6. Auditoría de altas, cambios y asignaciones.

### 10.1B — API

Dentro de una organización y establecimiento activos:

- listar/añadir/editar personal autorizado;
- listar/añadir/editar residentes;
- listar/asignar administradores del establecimiento;
- validar siempre `organization_id + location_id` en servidor.

### 10.1C — Portal administrativo

Al abrir un establecimiento mostrar:

- Resumen
- Personal
- Residentes / Pacientes
- Administración

El encabezado debe mostrar organización y establecimiento activos. Cambiar de establecimiento debe cambiar todo el contexto operativo visible.

## Compatibilidad

No se crearán tablas paralelas de cuidadores o residentes. Se reutilizan `workers`, `organization_worker_memberships` y `care_recipients` existentes para preservar Workforce, turnos, credenciales, Care, Compliance y agentes.

La tabla `locations` de Fase 10.0 permanece como fuente única de establecimientos.

## Criterios de aceptación

1. El propietario/administrador de organización puede ver todos sus establecimientos.
2. Un administrador de establecimiento ve únicamente los establecimientos asignados.
3. Personal y residentes de establecimiento A no aparecen en B sin asignación explícita.
4. Crear o editar datos exige coincidencia de organización y establecimiento en backend.
5. El aislamiento se prueba a nivel SQL/RLS y API, no solo UI.
6. Los módulos existentes continúan funcionando con datos legacy mientras se completa la transición.
