/**
 * Restaura os 12 conteúdos reprovados indevidamente para o estado "NAO_VOU_POSTAR".
 *
 * Uso (rodar no Railway, onde DATABASE_URL aponta para o Postgres interno):
 *   node scripts/restaurar-reprovados-nao-vou-postar.mjs              -> SIMULAÇÃO (padrão, não grava)
 *   node scripts/restaurar-reprovados-nao-vou-postar.mjs --apply      -> aplica (grava backup antes)
 *   node scripts/restaurar-reprovados-nao-vou-postar.mjs --rollback <arquivo-backup.json>
 *
 * Garantias:
 * - Só altera posts com status REPROVADO. Qualquer outro status é ignorado e reportado.
 * - Recusa posts com agendamento, publicação ou ID da Meta (nunca mexe em conteúdo publicado/agendado).
 * - Não move arquivos no Drive, não cria cópias, não reexecuta webhook.
 * - Preserva IDs, vínculos (post_media) e o histórico (rejections continua existindo; só sai da memória ativa).
 * - Tudo em uma transação: se qualquer etapa falhar, nada é gravado.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// IDs dos arquivos principais dos 12 cards (conforme levantamento). Um carrossel é resolvido pelo post.
const ARQUIVOS_PRINCIPAIS = [
  '1x2AIYLCoAAIk8AbF-hZl1KvKhi6clhAx', // 14-11 02 Post único
  '1xn_2SuNvDb73WaB_6thbKXpGBD_sPCPM', // 14-11 03 Story
  '1kFZ2zzYcepgZcTiugV9h05nQIjEu5MZi', // 04-11 03 Story
  '1bmG9g4eQOpQMYrfHsrAmIxnW0HB2TxQ1', // 01-11 02 Post único
  '1jz9z16VfkoVNrZxM7sf3YWGgBhSZe4-G', // 24-10 03 Story
  '1aHFcnSfJDGzrwA37x5BPY8qwiQPx7Yax', // 30-10 03 Post único
  '1CrqcZH9JGhCSkxteDjt0ipqNsvygGI7k', // 30-10 02 Post único
  '1PZ2G5_jiQDM8m5uiBXKkdwUUq63zi2LS', // 23-10 03 Story
  '1KLxxTaa0hzZw9jDaOFeZXLg9lVtItS3K', // 23-10 02 Post único
  '1XmXuBGiYrjUu5gfhX1ldT4jVUVG8gSgO', // 24-10 02 Post único
  '1dbIf1vhsVUT9byJh2nKuesUhNXtRwGIR', // 27-10 01 Carrossel (capa)
  '1aIGvlUmfVYblEPpXETgSt4d4IkpkjFe9', // 26-10 01 Carrossel (capa)
];

const args = process.argv.slice(2);
const APLICAR = args.includes('--apply');
const ROLLBACK_ARQUIVO = args.includes('--rollback') ? args[args.indexOf('--rollback') + 1] : null;
const PASTA_BACKUP = path.resolve('.data/backups');

function conectar() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida (rode no Railway).');
  const ssl = process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false };
  return new pg.Client({ connectionString: url, ssl });
}

const CAMPOS_RESTAURAR = [
  'status', 'scheduled_at', 'scheduled_account_id', 'is_approved_for_schedule', 'publish_attempts',
  'last_attempt_at', 'next_retry_at', 'failure_reason', 'publish_lock', 'child_container_ids', 'updated_at',
];

async function coluna(client, tabela, nome) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [tabela, nome]
  );
  return r.rowCount > 0;
}

async function rollback(client, arquivo) {
  const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  await client.query('BEGIN');
  try {
    for (const p of dados.posts) {
      await client.query(
        `UPDATE posts SET status=$2, scheduled_at=$3, scheduled_account_id=$4, is_approved_for_schedule=$5,
           publish_attempts=$6, last_attempt_at=$7, next_retry_at=$8, failure_reason=$9, publish_lock=$10,
           child_container_ids=$11, updated_at=$12 WHERE id=$1`,
        [p.id, p.status, p.scheduled_at, p.scheduled_account_id, p.is_approved_for_schedule, p.publish_attempts,
         p.last_attempt_at, p.next_retry_at, p.failure_reason, p.publish_lock,
         JSON.stringify(p.child_container_ids ?? []), p.updated_at]
      );
    }
    for (const m of dados.media) {
      await client.query(`UPDATE media_assets SET status=$2 WHERE drive_file_id=$1`, [m.drive_file_id, m.status]);
    }
    for (const r of dados.rejections) {
      await client.query(`UPDATE rejections SET ativa_na_memoria=$2 WHERE id=$1`, [r.id, r.ativa_na_memoria]);
    }
    await client.query('COMMIT');
    console.log(`Rollback concluído: ${dados.posts.length} posts, ${dados.media.length} mídias, ${dados.rejections.length} feedbacks.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const client = conectar();
  await client.connect();
  try {
    if (ROLLBACK_ARQUIVO) {
      return await rollback(client, path.resolve(ROLLBACK_ARQUIVO));
    }

    if (!(await coluna(client, 'rejections', 'ativa_na_memoria'))) {
      throw new Error('Coluna rejections.ativa_na_memoria não existe. Publique o servidor (migração 007) antes.');
    }

    // 1) Resolver os posts a partir dos arquivos principais (post_media) e dos IDs de post de item único.
    const resolvidos = await client.query(
      `SELECT DISTINCT p.id, p.status, p.nome, p.lote_nome, p.categoria, p.scheduled_at, p.published_at,
              p.instagram_media_id, p.instagram_container_id, p.is_approved_for_schedule
       FROM posts p
       LEFT JOIN post_media pm ON pm.post_id = p.id
       WHERE pm.drive_file_id = ANY($1::text[]) OR p.id = ANY($2::text[])`,
      [ARQUIVOS_PRINCIPAIS, ARQUIVOS_PRINCIPAIS.map((id) => `item_${id}`)]
    );

    const porId = new Map(resolvidos.rows.map((r) => [r.id, r]));
    const aRestaurar = [];
    const ignorados = [];
    for (const p of porId.values()) {
      if (p.status !== 'REPROVADO') {
        ignorados.push({ id: p.id, motivo: `status atual é ${p.status}, não REPROVADO` });
      } else if (p.scheduled_at || p.published_at || p.instagram_media_id || p.instagram_container_id || p.is_approved_for_schedule) {
        ignorados.push({ id: p.id, motivo: 'possui agendamento, publicação ou ID da Meta; recusado por segurança' });
      } else {
        aRestaurar.push(p);
      }
    }

    console.log(`\nPosts encontrados: ${porId.size} | a restaurar: ${aRestaurar.length} | ignorados: ${ignorados.length}`);
    for (const p of aRestaurar) console.log(`  + ${p.id}  (${p.categoria}, ${p.lote_nome})`);
    for (const i of ignorados) console.log(`  - ${i.id}: ${i.motivo}`);
    if (porId.size !== 12) console.log(`  ! esperado 12 conteúdos; encontrados ${porId.size}. Confira antes de aplicar.`);

    if (!APLICAR) {
      console.log('\nSIMULAÇÃO: nada foi gravado. Rode com --apply para aplicar.');
      return;
    }
    if (aRestaurar.length === 0) {
      console.log('Nada a restaurar.');
      return;
    }

    // 2) Backup de tudo que será alterado, antes de qualquer escrita.
    const ids = aRestaurar.map((p) => p.id);
    const posts = (await client.query(`SELECT * FROM posts WHERE id = ANY($1::text[])`, [ids])).rows;
    const media = (await client.query(
      `SELECT m.drive_file_id, m.status FROM media_assets m
       JOIN post_media pm ON pm.drive_file_id = m.drive_file_id WHERE pm.post_id = ANY($1::text[])`,
      [ids]
    )).rows;
    const rejections = (await client.query(
      `SELECT id, post_id, ativa_na_memoria FROM rejections WHERE post_id = ANY($1::text[])`,
      [ids]
    )).rows;

    fs.mkdirSync(PASTA_BACKUP, { recursive: true });
    const arquivoBackup = path.join(PASTA_BACKUP, `restaurar_reprovados_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(arquivoBackup, JSON.stringify({ criadoEm: new Date().toISOString(), posts, media, rejections }, null, 2));
    console.log(`\nBackup gravado em: ${arquivoBackup}`);

    // 3) Aplicação em transação única.
    await client.query('BEGIN');
    try {
      const up = await client.query(
        `UPDATE posts SET status = 'NAO_VOU_POSTAR', scheduled_at = NULL, scheduled_account_id = NULL,
           is_approved_for_schedule = FALSE, publish_attempts = 0, last_attempt_at = NULL, next_retry_at = NULL,
           failure_reason = NULL, publish_lock = NULL, child_container_ids = '[]'::jsonb, updated_at = NOW()
         WHERE id = ANY($1::text[]) AND status = 'REPROVADO'`,
        [ids]
      );
      await client.query(
        `UPDATE media_assets SET status = 'NAO_VOU_POSTAR', updated_at = NOW()
         WHERE status = 'REPROVADO' AND drive_file_id IN
           (SELECT drive_file_id FROM post_media WHERE post_id = ANY($1::text[]))`,
        [ids]
      );
      await client.query(
        `UPDATE rejections SET ativa_na_memoria = FALSE WHERE post_id = ANY($1::text[])`,
        [ids]
      );
      // Verificação antes do COMMIT
      const check = await client.query(
        `SELECT COUNT(*)::int AS n FROM posts WHERE id = ANY($1::text[]) AND status = 'NAO_VOU_POSTAR'`,
        [ids]
      );
      if (check.rows[0].n !== up.rowCount || up.rowCount !== aRestaurar.length) {
        throw new Error(`Verificação falhou: esperado ${aRestaurar.length}, atualizados ${up.rowCount}, confirmados ${check.rows[0].n}.`);
      }
      await client.query('COMMIT');
      console.log(`\nRestaurados: ${up.rowCount} posts para NAO_VOU_POSTAR.`);
      console.log(`Para desfazer: node scripts/restaurar-reprovados-nao-vou-postar.mjs --rollback "${arquivoBackup}"`);
      console.log('Reinicie o serviço no Railway para recarregar o estado em memória do Social Hub.');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('ERRO:', err.message);
  process.exitCode = 1;
});
