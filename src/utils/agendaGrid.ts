import type { PostGroup } from '../types/index.ts';

export type AgendaCell = { date: string; inMonth: boolean; posts: PostGroup[] };

/**
 * Grade mensal de 6 semanas (42 células) começando no domingo.
 * Cada post AGENDADO entra no dia (YYYY-MM-DD) do fuso `timezone`, ordenado por horário.
 * Posts com scheduledAt ausente ou inválido não aparecem.
 */
export function buildMonthGrid(
  year: number,
  month: number,
  posts: PostGroup[],
  timezone = 'America/Sao_Paulo'
): AgendaCell[] {
  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const byDay = new Map<string, { post: PostGroup; ms: number }[]>();
  for (const p of posts) {
    if (p.status !== 'AGENDADO') continue;
    const ms = Date.parse(p.scheduledAt || '');
    if (Number.isNaN(ms)) continue;
    const key = dayFmt.format(new Date(ms));
    const list = byDay.get(key) || [];
    list.push({ post: p, ms });
    byDay.set(key, list);
  }

  const first = new Date(Date.UTC(year, month, 1));
  const cells: AgendaCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(year, month, 1 - first.getUTCDay() + i));
    const date = d.toISOString().slice(0, 10);
    const list = (byDay.get(date) || [])
      .sort((a, b) => a.ms - b.ms)
      .map((x) => x.post);
    cells.push({ date, inMonth: d.getUTCMonth() === month, posts: list });
  }
  return cells;
}
