// routes/api.js — Entry point: mounts all sub-routers
const express = require('express')
const jwt = require('jsonwebtoken')
const router = express.Router()
const { globalLimiter, adminLimiter, getElectionStatus, getPortalMode, getJwtSecret, getOrgId } = require('./middleware')
const { query } = require('../db')
const votingRoutes = require('./voting')
const adminRoutes = require('./admin')
const nominationRoutes = require('./nominations')

// Apply global rate limiter to all API routes
router.use(globalLimiter)

// --- Admin login (returns JWT, must be BEFORE admin routes) ---
router.post('/admin-login', adminLimiter, (req, res) => {
    if (req.body.password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ message: 'Invalid password.' })
    }
    const token = jwt.sign({ role: 'admin' }, getJwtSecret(), { expiresIn: '2h' })
    res.json({ token })
})

router.get('/org', (req, res) => {
    res.json({
        id: getOrgId(),
        name: process.env.ORG_NAME || getOrgId(),
    })
})

// --- Election status (public, lightweight) ---
router.get('/election-status', async (req, res) => {
    try {
        const status = await getElectionStatus()
        const portalMode = await getPortalMode()
        res.json({ status, portalMode })
    } catch (error) {
        console.error('Error fetching election status:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.get('/elections/active', async (req, res) => {
    try {
        const result = await query(
            `select id, title, year, status
             from elections
             where organization_id = $1
             order by created_at desc
             limit 1`,
            [getOrgId()]
        )
        res.json(result.rows[0] || null)
    } catch (error) {
        console.error('Error fetching active election:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.get('/positions', async (req, res) => {
    try {
        const result = await query(
            `select id, title, group_key as "groupKey", department_id as "departmentId", sort_order as "sortOrder"
             from positions
             where organization_id = $1
             order by group_key, sort_order, title`,
            [getOrgId()]
        )
        res.json(result.rows)
    } catch (error) {
        console.error('Error fetching positions:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.get('/candidates', async (req, res) => {
    try {
        const result = await query(
            `select id, position_id as "positionId", name, description, image_url as "image"
             from candidates
             where organization_id = $1 and status = 'approved'
             order by name`,
            [getOrgId()]
        )
        res.json(result.rows)
    } catch (error) {
        console.error('Error fetching candidates:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.get('/departments', async (req, res) => {
    try {
        const result = await query(
            `select id, title from departments where organization_id = $1 order by sort_order, title`,
            [getOrgId()]
        )
        res.json(result.rows)
    } catch (error) {
        console.error('Error fetching departments:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.get('/ballot', async (req, res) => {
    try {
        const [positionsRes, candidatesRes, departmentsRes] = await Promise.all([
            query(
                `select id, title, group_key, department_id, sort_order
                 from positions
                 where organization_id = $1
                 order by sort_order, title`,
                [getOrgId()]
            ),
            query(
                `select id, position_id, name, description, image_url
                 from candidates
                 where organization_id = $1 and status = 'approved'
                 order by name`,
                [getOrgId()]
            ),
            query(
                `select id, title from departments where organization_id = $1 order by sort_order, title`,
                [getOrgId()]
            ),
        ])

        const candidatesByPosition = new Map()
        for (const candidate of candidatesRes.rows) {
            const items = candidatesByPosition.get(candidate.position_id) || []
            items.push({
                id: candidate.id,
                name: candidate.name,
                image: candidate.image_url,
                description: candidate.description,
            })
            candidatesByPosition.set(candidate.position_id, items)
        }

        const categories = []
        const departments = departmentsRes.rows.map(department => ({
            id: department.id,
            title: department.title,
            subcategories: [],
        }))
        const departmentMap = new Map(departments.map(department => [department.id, department]))

        for (const position of positionsRes.rows) {
            const category = {
                id: position.id,
                title: position.title,
                groupKey: position.group_key,
                nominees: candidatesByPosition.get(position.id) || [],
            }
            if (position.group_key === 'departmental' && position.department_id) {
                const department = departmentMap.get(position.department_id)
                if (department) department.subcategories.push(category)
            } else {
                categories.push(category)
            }
        }

        res.json({ categories, departments })
    } catch (error) {
        console.error('Error fetching ballot:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

// Mount sub-routers
router.use(votingRoutes)
router.use(nominationRoutes)
router.use(adminRoutes)

module.exports = router
