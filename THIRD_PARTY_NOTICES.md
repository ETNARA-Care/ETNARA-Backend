# Avisos de terceros

ETNARA Care usa bibliotecas de código abierto como dependencias. Cada una conserva su licencia. Las dependencias de producción usan sobre todo licencias MIT, Apache-2.0, ISC y BSD.

Requieren atención especial (biblioteca dinámica, no modificada, usada en el servidor):

| Paquete | Licencia | Uso |
| --- | --- | --- |
| `@img/sharp-libvips-*` (libvips, vía `sharp`) | LGPL-3.0-or-later | Procesamiento de imágenes en el servidor. Se usa sin modificar; se conserva su aviso de licencia. Fuente: https://github.com/lovell/sharp-libvips |
| `libheif-js` (vía `heic-decode`) | LGPL-3.0 | Lectura de fotos HEIC de iPhone en el servidor. Se usa sin modificar. Fuente: https://github.com/catdad-experiments/libheif-js |

Para regenerar el inventario: `npx license-checker-rseidelsohn --production --summary`.
