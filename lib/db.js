import { neon } from '@neondatabase/serverless';
export function db() { if(!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL and run db/schema.sql'); return neon(process.env.DATABASE_URL); }
