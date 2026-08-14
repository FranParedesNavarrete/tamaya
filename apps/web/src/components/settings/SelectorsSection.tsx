import { useEffect, useState } from 'react';
import { api, type SelectorsResponse } from '../../api/client';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card';
import { ConfirmDialog } from '../ui/alert-dialog';
import { MousePointerClick, Save, RotateCcw, CheckCircle2, AlertTriangle } from 'lucide-react';

/** Validación en cliente antes de enviar (el servidor revalida). */
function validateOverrides(text: string, editableKeys: string[]): { ok: true; value: Record<string, string[]> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON inválido: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'El valor debe ser un objeto JSON { clave: [selectores] }.' };
  }
  const obj = parsed as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (!editableKeys.includes(key)) {
      return { ok: false, error: `Clave no editable o desconocida: "${key}".` };
    }
    if (!Array.isArray(val) || val.length === 0 || !val.every((s) => typeof s === 'string' && s.trim().length > 0)) {
      return { ok: false, error: `"${key}" debe ser un array no vacío de strings no vacíos.` };
    }
  }
  return { ok: true, value: obj as Record<string, string[]> };
}

export function SelectorsSection() {
  const [data, setData] = useState<SelectorsResponse | null>(null);
  const [text, setText] = useState('{}');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const d = await api.getSelectors();
      setData(d);
      // El textarea contiene SOLO los overrides guardados, porque es exactamente
      // lo que se persiste al pulsar Guardar.
      //
      // Antes se rellenaba con los selectores EFECTIVOS (las 41 claves). Eso
      // convertía cualquier "Guardar" en un snapshot completo del código, y a
      // partir de ahí los defaults nuevos de cada despliegue quedaban tapados
      // por la copia congelada en BD: los arreglos de selectores no llegaban a
      // producción y había que volver a guardar a mano. Los efectivos se
      // consultan abajo, en un bloque de solo lectura.
      setText(JSON.stringify(d.overrides ?? {}, null, 2));
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function save() {
    setOkMsg(null);
    if (!data) return;
    const res = validateOverrides(text, data.editableKeys);
    if (!res.ok) {
      setValidationError(res.error);
      return;
    }
    setValidationError(null);
    setSaving(true);
    try {
      const r = await api.putSelectors(res.value);
      setData({ ...data, overrides: r.overrides, effective: r.effective });
      setText(JSON.stringify(r.overrides ?? {}, null, 2));
      setOkMsg(r.note);
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function doReset() {
    setConfirmReset(false);
    setOkMsg(null);
    setValidationError(null);
    setSaving(true);
    try {
      const r = await api.resetSelectors();
      if (data) setData({ ...data, overrides: r.overrides, effective: r.effective });
      // Sin overrides el editor queda vacío. Rellenarlo con los efectivos hacía
      // que el panel se viera IGUAL antes y después de restaurar (parecía que el
      // botón no hacía nada) y bastaba un Guardar para recrear el snapshot.
      setText('{}');
      setOkMsg(r.note);
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-foreground">
          <MousePointerClick className="h-4 w-4" /> Selectores WhatsApp
        </CardTitle>
        <CardDescription>
          Overrides de selectores para sobrevivir a cambios de WhatsApp Web sin tocar código.
          Los defaults se mantienen como fallback.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : data ? (
          <>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                <span className="font-medium text-foreground">Editables:</span>{' '}
                {data.editableKeys.join(', ')}
              </p>
              <p>
                <span className="font-medium text-foreground">No editables</span> (dinámicos, siempre defaults):{' '}
                {data.nonEditableKeys.join(', ')}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Overrides (JSON)</label>
              <Textarea
                value={text}
                onChange={(e) => { setText(e.target.value); setValidationError(null); setOkMsg(null); }}
                rows={12}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder={'{\n  "appReady": ["#pane-side"],\n  "sendButton": ["div[role=\'button\'][aria-label^=\'Send\']"]\n}'}
              />
              <p className="text-xs text-muted-foreground">
                Formato: <code>{'{ "clave": ["selector1", "selector2"] }'}</code>. Solo claves editables;
                cada valor es un array no vacío de selectores.
              </p>
              <p className="text-xs text-muted-foreground">
                Incluye <strong>solo las claves que quieras sobrescribir</strong>. Las que no estén aquí
                usan los defaults del código y se actualizan solas en cada despliegue. Un override
                congela esa clave: deja de recibir correcciones hasta que lo borres.
                <code>{'{}'}</code> = usar defaults para todo.
              </p>

              <details className="rounded-md border border-border p-2">
                <summary className="cursor-pointer text-xs font-medium">
                  Ver selectores efectivos ({data.editableKeys.length} claves) — solo consulta
                </summary>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Copia de aquí la clave que necesites y pégala arriba. No pegues el bloque entero:
                  sobrescribirías las {data.editableKeys.length} claves.
                </p>
                <pre className="mt-1.5 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[10px] leading-tight">
                  {JSON.stringify(data.effective, null, 2)}
                </pre>
              </details>
            </div>

            {validationError && (
              <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 p-2 text-xs text-red-600 flex items-start gap-1.5 break-all">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> <span>{validationError}</span>
              </div>
            )}
            {okMsg && (
              <div className="rounded-md border border-green-300 bg-green-50 dark:bg-green-950/30 p-2 text-xs text-green-700 dark:text-green-400 flex items-start gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" /> <span>{okMsg}</span>
              </div>
            )}

            <div className="rounded-md bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
              ⚠️ Los cambios afectan a worker-publish / control server. <b>Reinicia el worker</b> para
              garantizar que se apliquen (se leen al arrancar el proceso).
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Ver selectores efectivos actuales</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">
                {JSON.stringify(data.effective, null, 2)}
              </pre>
            </details>

            <div className="flex flex-wrap gap-2">
              <Button onClick={save} disabled={saving}>
                <Save className="h-4 w-4 mr-1" /> Guardar overrides
              </Button>
              <Button variant="outline" onClick={() => setConfirmReset(true)} disabled={saving}>
                <RotateCcw className="h-4 w-4 mr-1" /> Restaurar defaults
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-red-600">No se pudieron cargar los selectores.</p>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmReset}
        title="Restaurar selectores por defecto"
        description="Se borrarán los overrides guardados y se usarán solo los defaults del código. ¿Continuar?"
        confirmLabel="Restaurar"
        cancelLabel="Cancelar"
        onConfirm={doReset}
        onCancel={() => setConfirmReset(false)}
      />
    </Card>
  );
}
