import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Channel } from '@tamaya/shared-types';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Select } from '../components/ui/select';
import { DateTimePicker } from '../components/DateTimePicker';

interface MediaRow {
  source: string;
  originalName?: string;
  uploading?: boolean;
}

function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultScheduledAt(): string {
  const d = new Date(Date.now() + 5 * 60_000);
  return toDatetimeLocalValue(d);
}

export function NewJob() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const fromJobId = params.get('from');

  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState('');
  const [text, setText] = useState('');
  const [publishNow, setPublishNow] = useState(true);
  const [scheduledAt, setScheduledAt] = useState('');
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [prefilling, setPrefilling] = useState(Boolean(fromJobId));

  useEffect(() => {
    (async () => {
      const chs = await api.listChannels();
      setChannels(chs);

      if (fromJobId) {
        try {
          const src = await api.getJob(fromJobId);
          setChannelId(src.channelId);
          setText(src.text ?? '');
          setMedia(src.media.map(m => ({ source: m.source })));
          // Nueva fecha — por defecto "ahora", el usuario puede cambiar
          setPublishNow(true);
        } catch (e) {
          setErr(`No se pudo cargar el job original: ${e instanceof Error ? e.message : e}`);
        } finally {
          setPrefilling(false);
        }
      } else if (chs.length > 0) {
        setChannelId(chs[0].id);
      }
    })();

  }, [fromJobId]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      const scheduledDate = publishNow ? new Date() : new Date(scheduledAt);
      if (!publishNow && scheduledDate.getTime() <= Date.now() + 30_000) {
        throw new Error('La fecha programada debe estar al menos 30 segundos en el futuro.');
      }
      const iso = scheduledDate.toISOString();
      await api.createJob({
        channelId,
        text: text || undefined,
        media: media.filter(m => m.source).map(m => ({ source: m.source })),
        scheduledAt: iso,
      });
      nav('/');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const selectedChannel = channels.find(c => c.id === channelId);
  const filledMedia = media.filter(m => m.source);
  const publicationLabel = publishNow
    ? 'Ahora'
    : scheduledAt ? new Date(scheduledAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : 'Sin fecha';
  const previewText = text.trim() || 'Escribe un texto para previsualizar el caption…';
  const previewTextShort = previewText.length > 220 ? `${previewText.slice(0, 220)}…` : previewText;

  async function onFileSelected(idx: number, file: File) {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      setErr(`Tipo no soportado: ${file.type || 'desconocido'}. Solo imágenes y vídeos.`);
      return;
    }
    setErr(null);
    setMedia(curr => {
      const next = [...curr];
      next[idx] = { ...next[idx], uploading: true };
      return next;
    });
    try {
      const uploaded = await api.uploadMedia(file);
      setMedia(curr => {
        const next = [...curr];
        next[idx] = {
          source: uploaded.source,
          originalName: uploaded.originalName,
          uploading: false,
        };
        return next;
      });
    } catch (err) {
      setMedia(curr => {
        const next = [...curr];
        next[idx] = { ...next[idx], uploading: false };
        return next;
      });
      setErr(err instanceof Error ? err.message : String(err));
    }
  }

  if (prefilling) return <p className="p-6">Cargando job original…</p>;

  return (
    <form onSubmit={onSubmit} className="p-6 max-w-6xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold">
          {fromJobId ? 'Reintentar job' : 'Nuevo job'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Crea una publicación y revisa cómo quedará antes de encolarla.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
        <div className="space-y-4">
      <div>
        <Label>Canal<span className="text-destructive ml-0.5">*</span></Label>
        {channels.length === 0 ? (
          <p className="text-sm text-muted-foreground mt-1">
            No hay canales dados de alta.{' '}
            <Link to="/channels/new" className="underline">Crea uno primero</Link>.
          </p>
        ) : (
          <Select value={channelId} onChange={e => setChannelId(e.target.value)} required>
            {channels.map(c => (
              <option key={c.id} value={c.id}>
                {c.acronym ? `[${c.acronym}] ` : ''}{c.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      <div>
        <Label>Texto (se usa como caption si hay media)</Label>
        <Textarea value={text} onChange={e => setText(e.target.value)} rows={4} />
      </div>

      <div>
        <Label>Cuándo publicar<span className="text-destructive ml-0.5">*</span></Label>
        <div className="flex items-center gap-2 mt-1">
          <input
            type="checkbox"
            id="publishNow"
            checked={publishNow}
            onChange={e => {
              const checked = e.target.checked;
              setPublishNow(checked);
              if (!checked && !scheduledAt) setScheduledAt(defaultScheduledAt());
            }}
            className="h-4 w-4"
          />
          <label htmlFor="publishNow" className="text-sm cursor-pointer select-none">
            Publicar ahora
          </label>
        </div>
        {!publishNow && (
          <DateTimePicker
            value={scheduledAt}
            min={new Date(Date.now() + 30_000)}
            onChange={setScheduledAt}
          />
        )}
      </div>

      <div>
        <Label>Media</Label>
        <p className="text-xs text-muted-foreground mb-2">
          Por cada fila: pega una URL (s3://, https://, ruta absoluta) o sube un archivo.
          <br />
          <strong>Solo imágenes y vídeos.</strong> WhatsApp Channels no acepta documentos (PDF, Word, etc.) ni audio como documento.
        </p>
        {media.map((m, i) => (
          <div key={i} className="border rounded-md p-3 mt-2 space-y-2">
            <div className="flex gap-2">
              <Input value={m.source}
                     onChange={e => {
                       const next = [...media];
                       next[i] = { ...next[i], source: e.target.value };
                       setMedia(next);
                     }}
                     placeholder="s3://bucket/key.jpg o https://..." />
              <Button type="button" variant="outline"
                      onClick={() => setMedia(media.filter((_, j) => j !== i))}>
                Quitar
              </Button>
            </div>
            <div className="flex gap-2 items-center">
              <Input type="file" className="cursor-pointer"
                     accept="image/*,video/*"
                     onChange={e => {
                       const f = e.target.files?.[0];
                       if (f) onFileSelected(i, f);
                     }} />
              {m.uploading && <span className="text-xs text-muted-foreground">Subiendo…</span>}
              {m.originalName && !m.uploading &&
                <span className="text-xs text-green-600">{m.originalName}</span>}
            </div>
          </div>
        ))}
        <Button type="button" variant="outline" className="mt-2"
                onClick={() => setMedia([...media, { source: '' }])}>
          + Añadir media
        </Button>
      </div>

      {err && <p className="text-destructive">{err}</p>}

      <div className="flex gap-2">
        <Button type="submit"
                disabled={submitting || !channelId || media.some(m => m.uploading)}>
          {submitting
            ? 'Creando…'
            : fromJobId ? 'Reintentar' : (publishNow ? 'Publicar ahora' : 'Programar job')}
        </Button>
        <Button type="button" variant="outline" onClick={() => nav('/')}>
          Cancelar
        </Button>
      </div>
        </div>

        <aside className="lg:sticky lg:top-20">
          <div className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden">
            <div className="border-b px-4 py-3">
              <h2 className="text-base font-semibold">Preview de publicación</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Valida canal, media, copy y hora Madrid antes de encolar.
              </p>
            </div>
            <div className="p-4 space-y-4">
              <div className="mx-auto w-[300px] rounded-[2rem] bg-zinc-900 p-2 shadow-2xl">
                <div className="min-h-[500px] rounded-[1.5rem] bg-[#efeae2] p-3 overflow-hidden">
                  <div className="flex items-center gap-2 rounded-t-[1.2rem] rounded-b-md bg-[#075e54] px-3 py-2 text-white">
                    <div className="h-8 w-8 rounded-full bg-[#25d366]" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{selectedChannel?.name ?? 'Selecciona un canal'}</div>
                      <div className="text-[11px] opacity-80">WhatsApp Channel</div>
                    </div>
                  </div>
                  <div className="ml-auto mt-4 max-w-[245px] rounded-xl rounded-br-sm bg-[#dcf8c6] p-2 text-xs shadow-sm">
                    {filledMedia.length > 0 && (
                      <div className="mb-2 grid h-32 place-items-center rounded-lg bg-gradient-to-br from-zinc-100 to-zinc-300 font-semibold text-zinc-600">
                        {filledMedia.length === 1 ? 'Media' : `${filledMedia.length} medias`}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap break-words">{previewTextShort}</p>
                    <div className="mt-1 text-right text-[10px] text-slate-500">{publishNow ? 'ahora' : 'programado'} ✓</div>
                  </div>
                </div>
              </div>

              <div className="border-t pt-3 text-sm">
                <div className="flex justify-between gap-3 py-1.5">
                  <span className="text-muted-foreground">Canal</span>
                  <strong className="text-right truncate">{selectedChannel?.name ?? '—'}</strong>
                </div>
                <div className="flex justify-between gap-3 py-1.5">
                  <span className="text-muted-foreground">Media</span>
                  <strong>{filledMedia.length === 0 ? 'Sin media' : `${filledMedia.length} ${filledMedia.length === 1 ? 'archivo' : 'archivos'}`}</strong>
                </div>
                <div className="flex justify-between gap-3 py-1.5">
                  <span className="text-muted-foreground">Publicación</span>
                  <strong className="text-right">{publicationLabel}</strong>
                </div>
                <div className="flex justify-between gap-3 py-1.5">
                  <span className="text-muted-foreground">Pipeline</span>
                  <strong className="text-right">resolve inmediato → publish</strong>
                </div>
              </div>

              {filledMedia.length > 1 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                  <strong>Nota UX:</strong> multi media queda en stand by hasta que WhatsApp Channels lo permita de forma fiable.
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </form>
  );
}
