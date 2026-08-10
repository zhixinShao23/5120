/** Applies database/schema.sql to the configured Postgres database as-is. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const schemaPath = path.resolve(__dirname, '..', '..', 'database', 'schema.sql')

async function main() {
  const sql = fs.readFileSync(schemaPath, 'utf-8')
  await pool.query(sql)
  console.log(`Applied ${schemaPath}`)
  await pool.end()
}

main().catch((e) => {
  console.error('Failed to apply schema:', e.message)
  process.exitCode = 1
})
