#!/usr/bin/env bash
# Prueba de humo de la API: permisos, CSRF, roles, conteo a ciegas y bitácora.
# Uso: BASE=http://127.0.0.1:8780 bash servidor/tests/smoke_api.sh   (con la base vacía)
set -u
BASE=${BASE:-http://127.0.0.1:8780}
T=$(mktemp -d)
ok=0; ko=0
check() { if [ "$2" = "$3" ]; then ok=$((ok+1)); echo "  OK  $1"; else ko=$((ko+1)); echo "  FALLA $1 (esperado $3, obtuvo $2)"; fi; }
csrf() { curl -s -b "$T/$1" -c "$T/$1" "$BASE/api/sesion.php" | sed -E 's/.*"csrf":"([a-f0-9]+)".*/\1/'; }
call() { # sesion metodo ruta [json]
  local c; c=$(csrf "$1")
  curl -s -o "$T/out" -w "%{http_code}" -b "$T/$1" -c "$T/$1" -X "$2" -H "Content-Type: application/json" -H "X-CSRF-Token: $c" "$BASE/api/$3" ${4:+--data "$4"}
}
echo "Estado:"; curl -s "$BASE/api/estado.php"; echo
echo "CSRF:"
check "POST sin token CSRF es rechazado" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' "$BASE/api/setup.php")" 403
echo "Configuración:"
check "Clave común rechazada" "$(call admin POST setup.php '{"nombre":"Admin","usuario":"admin","clave":"admin123"}')" 400
check "Crear administrador" "$(call admin POST setup.php '{"nombre":"Admin Central","usuario":"admin","clave":"Central2026"}')" 200
check "Segunda configuración bloqueada" "$(call otro POST setup.php '{"nombre":"X","usuario":"x","clave":"Otra2026x"}')" 409
echo "Usuarios:"
check "Crear QF" "$(call admin POST usuarios.php '{"nombre":"Carla QF","usuario":"carla","rol":"qf","sucursal":"CL0007 RENCA","clave":"Revisa2026"}')" 200
check "Crear auxiliar" "$(call admin POST usuarios.php '{"nombre":"Pedro Aux","usuario":"pedro","rol":"auxiliar","sucursal":"CL0007 RENCA","clave":"Cuenta2026"}')" 200
check "Crear auxiliar de otra sucursal" "$(call admin POST usuarios.php '{"nombre":"Ana Aux","usuario":"ana","rol":"auxiliar","sucursal":"CL0009 MAIPU","clave":"Cuenta2026"}')" 200
check "Login auxiliar" "$(call aux POST login.php '{"usuario":"pedro","clave":"Cuenta2026"}')" 200
check "Login auxiliar otra sucursal" "$(call ana POST login.php '{"usuario":"ana","clave":"Cuenta2026"}')" 200
check "Login QF" "$(call qf POST login.php '{"usuario":"carla","clave":"Revisa2026"}')" 200
check "Auxiliar no puede administrar usuarios" "$(call aux GET usuarios.php)" 403
check "Auxiliar no puede crear usuarios" "$(call aux POST usuarios.php '{"nombre":"Hack","usuario":"hack","rol":"admin","clave":"Hackeo2026"}')" 403
echo "Documento:"
DOC='{"documento":{"id":"doc000001","tipo":"inventario","nombre":"Inventario CL0007","sucursal":"CL0007 RENCA","items":[{"id":"i1","sku":"CH9001","codigo":"7806130007772","producto":"ACIDO BORICO","cantidad":59,"precio":1000,"vencimiento":"2027-01-31"},{"id":"i2","sku":"CH6091","codigo":"7794640172731","producto":"ADHESIVO","cantidad":17,"precio":2000}],"counts":{},"extras":[],"evid":{},"log":[]}}'
check "Auxiliar no puede crear documentos" "$(call aux POST documentos.php "$DOC")" 403
check "Admin crea inventario" "$(call admin POST documentos.php "$DOC")" 200
check "Mapa vacío viaja como objeto (no lista)" "$(grep -c '"counts":{}' "$T/out")" 1
call aux GET 'documentos.php?id=doc000001' >/dev/null
check "Auxiliar NO recibe cantidades del sistema" "$(grep -c '"cantidad":59' "$T/out")" 0
check "Auxiliar NO recibe costos" "$(grep -c '"precio":1000' "$T/out")" 0
check "Auxiliar NO recibe vencimientos (los audita la QF)" "$(grep -c '"vencimiento"' "$T/out")" 0
check "Auxiliar de otra sucursal no ve el documento" "$(call ana GET 'documentos.php?id=doc000001')" 404
check "QF de la sucursal ve las cantidades" "$(call qf GET 'documentos.php?id=doc000001' >/dev/null; grep -c '"cantidad":59' "$T/out")" 1
check "QF ve el vencimiento" "$(grep -c '"vencimiento":"2027-01-31"' "$T/out")" 1
check "Auxiliar guarda su conteo" "$(call aux PUT 'documentos.php?id=doc000001' '{"version":1,"documento":{"counts":{"i1":59,"i2":6},"items":[{"id":"i1","cantidad":0}],"review":{"i2":{"decision":"correcta"}}}}')" 200
call qf GET 'documentos.php?id=doc000001' >/dev/null
check "El auxiliar no pudo cambiar cantidades del sistema" "$(grep -c '"cantidad":59' "$T/out")" 1
check "El conteo del auxiliar quedó guardado" "$(grep -c '"counts":{"i1":59,"i2":6}' "$T/out")" 1
check "El auxiliar no pudo registrar revisiones" "$(grep -c '"review":{"i2"' "$T/out")" 0
check "Versión antigua da conflicto" "$(call aux PUT 'documentos.php?id=doc000001' '{"version":1,"documento":{"counts":{"i1":1}}}')" 409
check "Auxiliar finaliza" "$(call aux PUT 'documentos.php?id=doc000001' '{"version":2,"documento":{"counts":{"i1":59,"i2":6},"finishedAt":1}}')" 200
check "Auxiliar no puede cambiar el conteo finalizado" "$(call aux PUT 'documentos.php?id=doc000001' '{"version":3,"documento":{"counts":{"i1":1,"i2":6}}}')" 403
check "Auxiliar no puede aprobar" "$(call aux PUT 'documentos.php?id=doc000001' '{"version":3,"documento":{"counts":{"i1":59,"i2":6},"verifiedAt":1}}' >/dev/null; grep -c verifiedAt "$T/out")" 0
check "QF no puede aprobar con pendientes" "$(call qf PUT 'documentos.php?id=doc000001' '{"version":4,"documento":{"counts":{"i1":59,"i2":6},"verifiedAt":1}}')" 409
check "QF revisa" "$(call qf PUT 'documentos.php?id=doc000001' '{"version":4,"documento":{"counts":{"i1":59,"i2":6},"review":{"i2":{"decision":"correcta","obs":"ok"}}}}')" 200
check "QF aprueba" "$(call qf PUT 'documentos.php?id=doc000001' '{"version":5,"documento":{"counts":{"i1":59,"i2":6},"verifiedAt":1}}')" 200
check "Aprobado queda a nombre del QF" "$(grep -c '"verifiedBy":"Carla QF"' "$T/out")" 1
echo "Evidencia:"
printf '\xff\xd8\xff\xe0fakejpg' > "$T/f.jpg"; printf '<?php echo 1;' > "$T/x.php"
c=$(csrf qf); check "Sube foto JPG" "$(curl -s -o "$T/out" -w '%{http_code}' -b "$T/qf" -c "$T/qf" -X POST -H "X-CSRF-Token: $c" --data-binary @"$T/f.jpg" "$BASE/api/evidencia.php?doc=doc000001")" 200
c=$(csrf qf); check "Rechaza archivo que no es foto" "$(curl -s -o /dev/null -w '%{http_code}' -b "$T/qf" -c "$T/qf" -X POST -H "X-CSRF-Token: $c" --data-binary @"$T/x.php" "$BASE/api/evidencia.php?doc=doc000001")" 400
echo "Bitácora:"
check "Auxiliar no puede ver la bitácora" "$(call aux GET bitacora.php)" 403
check "Auxiliar sí registra su actividad" "$(call aux POST bitacora.php '{"eventos":[{"accion":"Registró cantidad","producto":"ACIDO BORICO","detalle":"0 → 59","usuario":"admin"}]}')" 200
call admin GET bitacora.php >/dev/null
check "El usuario del evento lo pone el servidor (no el cliente)" "$(grep -o '"usuario":"pedro","nombre":"Pedro Aux","rol":"auxiliar","accion":"Registró cantidad"' "$T/out" | wc -l | tr -d ' ')" 1
check "Integridad OK" "$(call admin GET 'bitacora.php?verificar=1' >/dev/null; grep -c '"integra":true' "$T/out")" 1
echo "Bloqueo de inicio de sesión:"
for i in 1 2 3 4 5; do call bad POST login.php '{"usuario":"pedro","clave":"mala"}' >/dev/null; done
check "Tras 5 intentos queda bloqueado" "$(call bad POST login.php '{"usuario":"pedro","clave":"Cuenta2026"}')" 429
check "Logout" "$(call qf POST logout.php)" 200
check "Tras salir no hay acceso" "$(call qf GET documentos.php)" 401
echo; echo "Resultado: $ok OK, $ko con falla"
rm -rf "$T"; [ "$ko" = 0 ]
