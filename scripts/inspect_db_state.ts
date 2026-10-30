import 'dotenv/config';
import { dbQuery } from '../src/db/pool.ts';

async function main() {
  try {
    const accs = await dbQuery(`
      SELECT id, username, nome, instagram_user_id, status, connection_status,
             token_type, token_expires_at, drive_folder_name,
             (encrypted_access_token IS NOT NULL AND length(encrypted_access_token) > 20) as has_encrypted_token
      FROM instagram_accounts
    `);
    console.log('=== INSTAGRAM ACCOUNTS IN DB ===');
    console.log(JSON.stringify(accs.rows, null, 2));

    const posts = await dbQuery(`
      SELECT id, nome, lote_nome, categoria, status, scheduled_at, published_at,
             instagram_account_id, scheduled_account_id, publish_attempts, failure_reason,
             drive_folder_name
      FROM posts
      ORDER BY created_at DESC
      LIMIT 25
    `);
    console.log('=== RECENT POSTS IN DB ===');
    console.log(JSON.stringify(posts.rows, null, 2));

    const attempts = await dbQuery(`
      SELECT id, post_id, attempt_number, origin, status, http_status, meta_error_code, error_message, started_at
      FROM publication_attempts
      ORDER BY started_at DESC
      LIMIT 10
    `);
    console.log('=== RECENT PUBLICATION ATTEMPTS ===');
    console.log(JSON.stringify(attempts.rows, null, 2));
  } catch (err: any) {
    console.error('Error inspecting DB:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
