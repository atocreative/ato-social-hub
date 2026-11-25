/**
 * INVENTÁRIO SOMENTE LEITURA da aba "Não vou postar".
 * Não grava nada (transação read-only). Rodar no Railway, onde DATABASE_URL é acessível:
 *   node scripts/inventario-nao-vou-postar.mjs
 * Gera .data/inventario_nao_vou_postar_<data>.json com um registro por conteúdo.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definida. Rode no Railway.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query('BEGIN READ ONLY');

  const posts = (await client.query(`
    SELECT p.id, p.nome, p.lote_nome, p.categoria, p.status, p.pasta_cliente_nome, p.pasta_cliente_id,
           p.caption, p.caption_approved, p.scheduled_at, p.published_at, p.instagram_media_id,
           p.rejection_feedback IS NOT NULL AS tem_feedback, p.updated_at
    FROM posts p
    WHERE p.status = 'NAO_VOU_POSTAR'
    ORDER BY p.lote_nome ASC, p.id ASC
  `)).rows;

  const midias = (await client.query(`
    SELECT pm.post_id, pm.ordem, m.drive_file_id, m.nome, m.status AS status_midia, m.mime_type
    FROM post_media pm
    JOIN media_assets m ON m.drive_file_id = pm.drive_file_id
    WHERE pm.post_id = ANY($1::text[])
    ORDER BY pm.post_id, pm.ordem ASC, m.nome ASC
  `, [posts.map((p) => p.id)])).rows;

  const rejeicoes = (await client.query(`
    SELECT post_id, COUNT(*)::int AS n FROM rejections
    WHERE post_id = ANY($1::text[]) GROUP BY post_id
  `, [posts.map((p) => p.id)])).rows;
  const rejPorPost = new Map(rejeicoes.map((r) => [r.post_id, r.n]));

  await client.query('COMMIT');

  const registros = posts.map((p) => {
    const slides = midias.filter((m) => m.post_id === p.id);
    const excluido = [];
    if (p.scheduled_at) excluido.push('agendado');
    if (p.published_at || p.instagram_media_id) excluido.push('publicado');
    return {
      id: p.id,
      nome: p.nome,
      lote: p.lote_nome,
      formato: p.categoria,
      pasta: p.pasta_cliente_nome,
      pastaId: p.pasta_cliente_id,
      legenda: p.caption,
      legendaAprovada: p.caption_approved,
      status: p.status,
      temFeedbackAnterior: p.tem_feedback,
      reprovacoesNoBanco: rejPorPost.get(p.id) || 0,
      atualizadoEm: p.updated_at,
      slides: slides.map((s) => ({
        ordem: s.ordem,
        driveFileId: s.drive_file_id,
        nome: s.nome,
        statusMidia: s.status_midia,
      })),
      // Motivo de exclusão da operação, se houver
      excluidoDaOperacao: excluido,
    };
  });

  const elegiveis = registros.filter((r) => r.excluidoDaOperacao.length === 0);
  const resumo = {
    totalNaoVouPostar: registros.length,
    elegiveis: elegiveis.length,
    excluidos: registros.length - elegiveis.length,
    porFormato: elegiveis.reduce((acc, r) => ({ ...acc, [r.formato]: (acc[r.formato] || 0) + 1 }), {}),
    comFeedbackAnterior: elegiveis.filter((r) => r.temFeedbackAnterior).length,
  };

  const pasta = path.resolve('.data');
  fs.mkdirSync(pasta, { recursive: true });
  const arquivo = path.join(pasta, `inventario_nao_vou_postar_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(arquivo, JSON.stringify({ resumo, registros }, null, 2));

  console.log(JSON.stringify(resumo, null, 2));
  console.log(`\nInventário gravado em: ${arquivo}`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('ERRO:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
