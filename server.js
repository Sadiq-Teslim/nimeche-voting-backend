// backend/server.js
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const apiRoutes = require('./routes/api')
const { checkConnection } = require('./db')

const app = express()

// Trust proxy (required for Render/Heroku — correct client IP for rate limiting)
app.set('trust proxy', 1)

// --- CORS ---
const allowedOrigins = (process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)

app.use(cors({
    origin: function(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true)
        } else {
            callback(new Error('Not allowed by CORS'))
        }
    },
    credentials: true
}))

// --- Body parsing (limit payload size to prevent abuse) ---
app.use(express.json({ limit: '100kb' }))
app.use(cookieParser())

app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    next()
})

// --- Health check (Fix #10) ---
app.get('/health', async (req, res) => {
    try {
        await checkConnection()
        res.status(200).json({
            status: 'ok',
            uptime: Math.floor(process.uptime()),
            dbConnected: true,
            orgId: process.env.ORG_ID || null,
        })
    } catch {
        res.status(503).json({
            status: 'degraded',
            uptime: Math.floor(process.uptime()),
            dbConnected: false,
            orgId: process.env.ORG_ID || null,
        })
    }
})

app.get('/api/health', async (req, res) => {
    try {
        await checkConnection()
        res.status(200).json({
            status: 'ok',
            uptime: Math.floor(process.uptime()),
            dbConnected: true,
        })
    } catch {
        res.status(503).json({
            status: 'degraded',
            uptime: Math.floor(process.uptime()),
            dbConnected: false,
        })
    }
})

if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. API routes that read/write data will fail until Postgres is configured.')
} else {
    checkConnection()
        .then(() => console.log('Postgres connected'))
        .catch(err => console.error('Postgres connection error:', err.message))
}

// --- API routes ---
app.use('/api', apiRoutes)

// --- Start server ---
const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
    console.log(`Voting server running on port ${PORT}`)
})
