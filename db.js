const { Pool } = require('pg')

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX || 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
})

async function query(text, params) {
    return pool.query(text, params)
}

async function transaction(callback) {
    const client = await pool.connect()
    try {
        await client.query('BEGIN')
        const result = await callback(client)
        await client.query('COMMIT')
        return result
    } catch (error) {
        await client.query('ROLLBACK')
        throw error
    } finally {
        client.release()
    }
}

async function checkConnection() {
    await pool.query('select 1')
}

module.exports = {
    pool,
    query,
    transaction,
    checkConnection,
}
