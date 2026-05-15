import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Channel } from '@tamaya/shared-types';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Select } from '../components/ui/select';

interface MediaRow {
  source: string;
  originalName?: string;
  uploading?: boolean;
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
      const iso = publishNow
        ? new Date().toISOString()
        : new Date(scheduledAt).toISOString();
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
    <form onSubmit={onSubmit} className="p-6 max-w-2xl mx-auto space-y-4">
      <h1 className="text-2xl font-bold">
        {fromJobId ? 'Reintentar job' : 'Nuevo job'}
      </h1>

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
            onChange={e => setPublishNow(e.target.checked)}
            className="h-4 w-4"
          />
          <label htmlFor="publishNow" className="text-sm cursor-pointer select-none">
            Publicar ahora
          </label>
        </div>
        {!publishNow && (
          <Input
            type="datetime-local"
            value={scheduledAt}
            onChange={e => setScheduledAt(e.target.value)}
            required={!publishNow}
            className="mt-2"
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
    </form>
  );
}
