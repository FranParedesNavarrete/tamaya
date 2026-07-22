import { useMemo, useState } from 'react';
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isBefore, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths } from 'date-fns';
import { es } from 'date-fns/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { Select } from './ui/select';
import { cn } from '../lib/utils';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toLocalValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalValue(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function nextRoundedDate(minutesStep: number): Date {
  const d = new Date(Date.now() + 5 * 60_000);
  d.setSeconds(0, 0);
  const m = Math.ceil(d.getMinutes() / minutesStep) * minutesStep;
  if (m >= 60) {
    d.setHours(d.getHours() + 1, 0, 0, 0);
  } else {
    d.setMinutes(m, 0, 0);
  }
  return d;
}

export interface DateTimePickerProps {
  value: string;
  onChange: (value: string) => void;
  min?: Date;
  minutesStep?: number;
}

export function DateTimePicker({ value, onChange, min, minutesStep = 5 }: DateTimePickerProps) {
  const selected = fromLocalValue(value) ?? nextRoundedDate(minutesStep);
  const minDate = min ?? new Date();
  const [visibleMonth, setVisibleMonth] = useState(startOfMonth(selected));

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(visibleMonth), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(visibleMonth), { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [visibleMonth]);

  const hours = Array.from({ length: 24 }, (_, h) => h);
  const minutes = Array.from({ length: Math.floor(60 / minutesStep) }, (_, i) => i * minutesStep);

  function commit(next: Date) {
    const normalized = new Date(next);
    normalized.setSeconds(0, 0);
    onChange(toLocalValue(normalized));
  }

  function setDay(day: Date) {
    const next = new Date(selected);
    next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
    commit(next);
  }

  function setHour(hour: number) {
    const next = new Date(selected);
    next.setHours(hour);
    commit(next);
  }

  function setMinute(minute: number) {
    const next = new Date(selected);
    next.setMinutes(minute);
    commit(next);
  }

  function applyPreset(kind: 'now' | 'plus5' | 'tomorrow9') {
    const d = new Date();
    if (kind === 'now') {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else if (kind === 'plus5') {
      d.setMinutes(d.getMinutes() + 5, 0, 0);
    } else {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    }
    setVisibleMonth(startOfMonth(d));
    commit(d);
  }

  const selectedDayStart = new Date(selected);
  selectedDayStart.setHours(0, 0, 0, 0);
  const minDayStart = new Date(minDate);
  minDayStart.setHours(0, 0, 0, 0);

  return (
    <div className="mt-2 rounded-lg border bg-card p-3 shadow-sm space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => applyPreset('plus5')}>+5 min</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => applyPreset('tomorrow9')}>Mañana 09:00</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => applyPreset('now')}>Lo antes posible</Button>
      </div>

      <div className="flex items-center justify-between">
        <Button type="button" size="sm" variant="ghost" onClick={() => setVisibleMonth(subMonths(visibleMonth, 1))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="text-sm font-medium capitalize">
          {format(visibleMonth, 'LLLL yyyy', { locale: es })}
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
        {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((day) => {
          const disabled = isBefore(day, minDayStart);
          const active = isSameDay(day, selected);
          return (
            <button
              key={day.toISOString()}
              type="button"
              disabled={disabled}
              onClick={() => setDay(day)}
              className={cn(
                'h-9 rounded-md text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30',
                !isSameMonth(day, visibleMonth) && 'text-muted-foreground/50',
                active && 'bg-primary text-primary-foreground hover:bg-primary',
              )}
            >
              {format(day, 'd')}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <Select value={String(selected.getHours())} onChange={(e) => setHour(Number(e.target.value))}>
          {hours.map((h) => <option key={h} value={h}>{pad(h)}</option>)}
        </Select>
        <span className="text-muted-foreground">:</span>
        <Select value={String(Math.floor(selected.getMinutes() / minutesStep) * minutesStep)} onChange={(e) => setMinute(Number(e.target.value))}>
          {minutes.map((m) => <option key={m} value={m}>{pad(m)}</option>)}
        </Select>
      </div>

      <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        Programado para: <span className="font-medium text-foreground">{format(selected, "dd/MM/yyyy 'a las' HH:mm")}</span>
      </div>
    </div>
  );
}
