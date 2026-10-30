import { dbQuery } from './pool.ts';

export interface StoredThumbnail {
  data: Buffer;
  contentType: string;
  etag: string;
}

/**
 * Lê uma miniatura já otimizada guardada no Postgres (BYTEA).
 * Retorna null se não existir ou se o banco estiver indisponível (o chamador faz fallback).
 */
export async function getStoredThumbnail(fileId: string, width: number): Promise<StoredThumbnail | null> {
  try {
    const res = await dbQuery<{ data: Buffer; content_type: string; etag: string }>(
      'SELECT data, content_type, etag FROM media_thumbnails WHERE file_id = $1 AND width = $2',
      [fileId, width]
    );
    const row = res.rows[0];
    if (!row) return null;
    return { data: Buffer.from(row.data), contentType: row.content_type, etag: row.etag };
  } catch (err: any) {
    console.warn('[Media Thumb] Leitura do cache no banco falhou:', err.message);
    return null;
  }
}

/** Grava (ou substitui) uma miniatura otimizada no Postgres. */
export async function saveStoredThumbnail(
  fileId: string,
  width: number,
  data: Buffer,
  contentType: string,
  etag: string
): Promise<void> {
  try {
    await dbQuery(
      `INSERT INTO media_thumbnails (file_id, width, content_type, data, bytes, etag)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (file_id, width) DO UPDATE SET
         content_type = EXCLUDED.content_type,
         data = EXCLUDED.data,
         bytes = EXCLUDED.bytes,
         etag = EXCLUDED.etag,
         created_at = NOW()`,
      [fileId, width, contentType, data, data.length, etag]
    );
  } catch (err: any) {
    console.warn('[Media Thumb] Gravação no banco falhou:', err.message);
  }
}

/** Retorna quais ids (para uma largura) já estão no banco, para não baixar de novo. */
export async function listStoredFileIds(fileIds: string[], width: number): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set();
  try {
    const res = await dbQuery<{ file_id: string }>(
      'SELECT file_id FROM media_thumbnails WHERE width = $1 AND file_id = ANY($2::text[])',
      [width, fileIds]
    );
    return new Set(res.rows.map((r) => r.file_id));
  } catch (err: any) {
    console.warn('[Media Thumb] Listagem do cache falhou:', err.message);
    return new Set();
  }
}
