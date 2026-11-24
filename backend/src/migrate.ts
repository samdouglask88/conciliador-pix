import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { transaction } from './db'

export async function migrate(pool: Pool) {
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(98763124)')
    await client.query('CREATE TABLE IF NOT EXISTS identity_migrations (version integer PRIMARY KEY)')
    const directory = resolve(__dirname, '../../migrations')
    const files = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort()
    const { rows } = await client.query<{ version: number }>('SELECT version FROM identity_migrations')
    const applied = new Set(rows.map(row => row.version))
    for (const file of files) {
      const version = Number(file.slice(0, 3))
      if (applied.has(version)) continue
      await client.query(await readFile(resolve(directory, file), 'utf8'))
      await client.query('INSERT INTO identity_migrations VALUES ($1)', [version])
      applied.add(version)
    }
  })
}

if (require.main === module) {
  const url = process.env.DATABASE_URL
  if (!url) { console.error('DATABASE_URL obrigatória.'); process.exitCode = 1 }
  else {
    const pool = new Pool({ connectionString: url })
    migrate(pool).then(() => console.info('Migrações de identidade aplicadas.'))
      .catch(() => { console.error('Falha ao aplicar migrações de identidade.'); process.exitCode = 1 })
      .finally(() => pool.end())
  }
}

