import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const { Pool } = pg

const {
  DB_USER = 'postgres',
  DB_PASSWORD = '',
  DB_HOST = 'localhost',
  DB_PORT = '5432',
  DB_NAME = 'postgres',
  DB_SSL, // set to 'true' for AWS RDS etc.
} = process.env

export const pool = new Pool({
  user: DB_USER,
  password: DB_PASSWORD,
  host: DB_HOST,
  port: Number(DB_PORT),
  database: DB_NAME,
  ssl: DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
})
