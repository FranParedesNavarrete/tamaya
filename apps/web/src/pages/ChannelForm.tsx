import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';

export function ChannelForm() {
  const nav = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const isEdit = Boolean(id);

  const [acronym, setAcronym] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEdit);

  useEffect(() => {
    if (!isEdit || !id) return;
    (async () => {
      try {
        const ch = await api.getChannel(id);
        setAcronym(ch.acronym ?? '');
        setName(ch.name);
        setDescription(ch.description ?? '');
        setInviteLink(ch.inviteLink ?? '');
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id, isEdit]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    const payload = {
      acronym: acronym || undefined,
      name,
      description: description || undefined,
      inviteLink: inviteLink || undefined,
    };
    try {
      if (isEdit && id) {
        await api.updateChannel(id, payload);
      } else {
        await api.createChannel(payload);
      }
      nav('/channels');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <p className="p-6">Cargando…</p>;

  return (
    <form onSubmit={onSubmit} className="p-6 max-w-2xl mx-auto space-y-4">
      <h1 className="text-2xl font-bold">
        {isEdit ? 'Editar canal' : 'Nuevo canal'}
      </h1>

      <div>
        <Label>Acrónimo</Label>
        <Input value={acronym} onChange={e => setAcronym(e.target.value)}
               maxLength={16} placeholder="p.ej. PN8N" />
      </div>

      <div>
        <Label>Nombre *</Label>
        <Input value={name} onChange={e => setName(e.target.value)} required
               placeholder="Nombre exacto del canal en WhatsApp" />
      </div>

      <div>
        <Label>Descripción</Label>
        <Textarea value={description} onChange={e => setDescription(e.target.value)}
                  rows={3} />
      </div>

      <div>
        <Label>Invite link (opcional)</Label>
        <Input type="url" value={inviteLink} onChange={e => setInviteLink(e.target.value)}
               placeholder="https://whatsapp.com/channel/..." />
      </div>

      {err && <p className="text-destructive">{err}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Guardando…' : (isEdit ? 'Guardar cambios' : 'Crear canal')}
        </Button>
        <Button type="button" variant="outline" onClick={() => nav('/channels')}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
