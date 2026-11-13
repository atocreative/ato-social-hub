import type { PostGroup } from '../types/index.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export function summarizePosts(
  posts: PostGroup[],
  now: Date
): { scheduled: number; publishedThisWeek: number; failed: number } {
  let scheduled = 0;
  let publishedThisWeek = 0;
  let failed = 0;
  const nowMs = now.getTime();

  for (const p of posts) {
    if (p.status === 'AGENDADO') scheduled++;
    if (p.status === 'PUBLICADO') {
      const t = Date.parse(p.publishedAt || '');
      if (!Number.isNaN(t) && nowMs - t >= 0 && nowMs - t <= 7 * DAY_MS) publishedThisWeek++;
    }
    if (p.status === 'FALHA_PUBLICACAO' || p.status === 'RECONEXAO_NECESSARIA') failed++;
  }

  return { scheduled, publishedThisWeek, failed };
}

export function upcomingPosts(posts: PostGroup[], now: Date, limit: number): PostGroup[] {
  const nowMs = now.getTime();
  return posts
    .filter((p) => {
      if (p.status !== 'AGENDADO') return false;
      const t = Date.parse(p.scheduledAt || '');
      return !Number.isNaN(t) && t >= nowMs;
    })
    .sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!))
    .slice(0, limit);
}
