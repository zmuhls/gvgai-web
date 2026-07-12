const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createPostgresPool } = require('../lib/postgres-pool');
const { _private: wallPrivate } = require('../lib/cadavre-wall-store');

function normalizeLegacyRow(row) {
  const payload = row?.payload;
  const createdAt = wallPrivate.isoTimestamp(row?.created_at);
  if (!wallPrivate.UUID_RE.test(String(row?.event_id || '')) || !createdAt || !payload) return null;
  if (!wallPrivate.TOKEN_RE.test(String(payload.delete_token_hash || ''))) return null;

  try {
    const authorName = wallPrivate.cleanText(payload.name, {
      field: 'name', maxLength: 80, singleLine: true
    }) || 'anonymous';
    const poem = wallPrivate.cleanText(payload.poem, {
      field: 'poem', maxLength: 12000, required: true
    });
    const analysis = wallPrivate.cleanText(payload.analysis, {
      field: 'analysis', maxLength: 16000
    });
    return {
      id: row.event_id,
      createdAt,
      authorName,
      poem,
      analysis: analysis || null,
      deleteTokenHash: payload.delete_token_hash.toLowerCase()
    };
  } catch {
    return null;
  }
}

async function importVolume(options = {}) {
  const env = options.env || process.env;
  const configuredPath = String(options.filePath || env.CADAVRE_WALL_FALLBACK_PATH || '').trim();
  if (!configuredPath) {
    console.log('[Wall import] no volume file is configured.');
    return {
      found: 0, imported: 0, previouslyImported: 0, skipped: 0, alreadyImported: false
    };
  }

  const filePath = path.resolve(configuredPath);
  if (!fs.existsSync(filePath)) {
    console.log(`[Wall import] volume file is absent: ${filePath}`);
    return {
      found: 0, imported: 0, previouslyImported: 0, skipped: 0, alreadyImported: false
    };
  }

  const source = fs.readFileSync(filePath);
  const sourceDigest = crypto.createHash('sha256').update(source).digest('hex');
  const parsed = JSON.parse(source.toString('utf8'));
  if (!Array.isArray(parsed)) throw new Error('The volume wall file must contain a JSON array.');
  const rows = parsed.map(normalizeLegacyRow);
  const invalidIndexes = rows.flatMap((row, index) => row ? [] : [index]);
  if (invalidIndexes.length) {
    throw new Error(`The volume wall file has invalid row(s) at index ${invalidIndexes.join(', ')}.`);
  }

  const pool = options.pool || createPostgresPool(env, { max: 1 });
  const ownsPool = !options.pool;
  let client = null;
  let imported = 0;
  let skipped = 0;
  let previouslyImported = 0;
  let alreadyImported = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('inference-arcade-wall-volume-import'))");
    const previous = await client.query(`
      SELECT source_row_count, imported_row_count
      FROM wall_volume_imports
      WHERE source_digest = $1
    `, [sourceDigest]);
    if (previous.rows[0]) {
      alreadyImported = true;
      previouslyImported = previous.rows[0].imported_row_count;
      skipped = parsed.length;
    }
    for (const row of rows) {
      if (alreadyImported) break;
      const handled = await client.query(`
        SELECT wall_post_id
        FROM wall_volume_imported_rows
        WHERE wall_post_id = $1::uuid
      `, [row.id]);
      if (handled.rows[0]) {
        skipped += 1;
        continue;
      }
      const result = await client.query(`
        INSERT INTO wall_posts (
          id, created_at, author_name, poem, analysis, delete_token_hash
        ) VALUES ($1::uuid, $2::timestamptz, $3, $4, $5, $6)
        ON CONFLICT (id) DO NOTHING
      `, [row.id, row.createdAt, row.authorName, row.poem, row.analysis, row.deleteTokenHash]);
      if (result.rowCount !== 1) {
        throw new Error(`Volume row ${row.id} conflicts with an existing wall post.`);
      }
      await client.query(`
        INSERT INTO wall_volume_imported_rows (wall_post_id, source_digest)
        VALUES ($1::uuid, $2)
      `, [row.id, sourceDigest]);
      imported += 1;
    }
    if (!alreadyImported) {
      await client.query(`
        INSERT INTO wall_volume_imports (
          source_digest, source_name, source_row_count, imported_row_count
        ) VALUES ($1, $2, $3, $4)
      `, [sourceDigest, path.basename(filePath), parsed.length, imported]);
    }
    await client.query('COMMIT');
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }
    throw error;
  } finally {
    if (client) client.release();
    if (ownsPool) await pool.end();
  }

  const disposition = alreadyImported
    ? `previously imported ${previouslyImported}`
    : `imported ${imported}`;
  console.log(`[Wall import] found ${parsed.length} row(s); ${disposition}; skipped ${skipped}.`);
  return { found: parsed.length, imported, previouslyImported, skipped, alreadyImported };
}

if (require.main === module) {
  importVolume().catch((error) => {
    console.error(`[Wall import] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  importVolume,
  normalizeLegacyRow
};
