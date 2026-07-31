// routes/admin.js — Admin-only endpoints (results, settings, reset)
const express = require('express')
const router = express.Router()
const { query, transaction } = require('../db')
const { adminLimiter, requireAdmin, invalidateElectionCache, getOrgId } = require('./middleware')

// All admin routes require rate limiting + password auth
router.use(adminLimiter)
router.use(requireAdmin)

// --- Results (aggregated vote counts) ---
router.post('/results', async (req, res) => {
    try {
        const result = await query(
            `select
                v.position_id as category,
                c.name,
                count(*)::int as votes
             from votes v
             join candidates c on c.id = v.candidate_id
             where v.organization_id = $1
             group by v.position_id, c.name
             order by v.position_id, votes desc, c.name`,
            [getOrgId()]
        )
        const grouped = new Map()
        for (const row of result.rows) {
            const nominees = grouped.get(row.category) || []
            nominees.push({ name: row.name, votes: row.votes })
            grouped.set(row.category, nominees)
        }
        res.json(Array.from(grouped.entries()).map(([category, nominees]) => ({ category, nominees })))
    } catch (error) {
        console.error('Error fetching results:', error)
        res.status(500).json({ message: 'A server error occurred while fetching results.' })
    }
})

// --- Pending nominations (paginated) ---
router.post('/pending-nominations', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.body.page) || 1)
        const limit = Math.min(100, Math.max(1, parseInt(req.body.limit) || 50))
        const skip = (page - 1) * limit

        const [pending, total] = await Promise.all([
            query(
                `select id, full_name as "fullName", popular_name as "popularName", position_id as category,
                        image_url as "imageUrl", submitted_at as "submittedAt"
                 from nominations
                 where organization_id = $1 and status = 'pending'
                 order by submitted_at desc
                 offset $2 limit $3`,
                [getOrgId(), skip, limit]
            ),
            query(
                `select count(*)::int as count from nominations where organization_id = $1 and status = 'pending'`,
                [getOrgId()]
            ),
        ])
        const count = total.rows[0]?.count || 0
        res.json({ nominations: pending.rows, total: count, page, totalPages: Math.ceil(count / limit) })
    } catch (error) {
        console.error('Error fetching pending nominations:', error)
        res.status(500).json({ message: 'Error fetching pending nominations.' })
    }
})

// --- Toggle election status ---
router.post('/toggle-election', async (req, res) => {
    try {
        const result = await query(
            `with current_status as (
                select coalesce(
                    (select value from settings where organization_id = $1 and key = 'electionStatus'),
                    (select status from elections where organization_id = $1 order by created_at desc limit 1),
                    'closed'
                ) as value
            ),
            updated_setting as (
                insert into settings (organization_id, key, value)
                select $1, 'electionStatus', case when value = 'open' then 'closed' else 'open' end
                from current_status
                on conflict (organization_id, key) do update
                set value = excluded.value, updated_at = now()
                returning value
            )
            update elections
            set status = (select value from updated_setting)
            where id = (
                select id from elections where organization_id = $1 order by created_at desc limit 1
            )
            returning status`,
            [getOrgId()]
        )
        const status = result.rows[0]?.status || 'closed'
        invalidateElectionCache()
        console.log(`[AUDIT] Election toggled to: ${status}`)
        res.json({ success: true, newStatus: status })
    } catch (error) {
        console.error('Error toggling election status:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

// --- Delete all nominations ---
router.post('/delete-nominations', async (req, res) => {
    try {
        const result = await query(
            `delete from nominations where organization_id = $1 and status = 'pending'`,
            [getOrgId()]
        )
        console.log(`[AUDIT] Deleted ${result.rowCount} pending nominations`)
        res.json({ success: true, message: `${result.rowCount} pending nominations have been deleted.` })
    } catch (error) {
        console.error('Error deleting nominations:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

// --- Approve a nomination (move to candidates, change status to approved) ---
router.post('/approve-nomination', async (req, res) => {
    const { nominationId, description } = req.body
    if (!nominationId) return res.status(400).json({ message: 'Nomination ID is required.' })

    try {
        await transaction(async (client) => {
            // 1. Get the nomination details
            const nomRes = await client.query(
                `select full_name, popular_name, position_id, image_url, election_id
                 from nominations
                 where organization_id = $1 and id = $2 and status = 'pending'`,
                [getOrgId(), nominationId]
            )

            if (nomRes.rows.length === 0) {
                throw new Error('Nomination not found or already processed.')
            }

            const nom = nomRes.rows[0]
            // Format candidate name: "FirstName LastName (PopularName/Level)" if popular_name exists
            let candidateName = nom.full_name
            if (nom.popular_name) {
                candidateName = `${nom.full_name} (${nom.popular_name})`
            }

            // 2. Insert into candidates
            await client.query(
                `insert into candidates (organization_id, election_id, position_id, name, description, image_url, status)
                 values ($1, $2, $3, $4, $5, $6, 'approved')
                 on conflict (election_id, position_id, lower(name)) do update
                 set image_url = coalesce(excluded.image_url, candidates.image_url)`,
                [
                    getOrgId(),
                    nom.election_id,
                    nom.position_id,
                    candidateName.trim(),
                    description || null,
                    nom.image_url || null
                ]
            )

            // 3. Mark nomination as approved
            await client.query(
                `update nominations
                 set status = 'approved'
                 where organization_id = $1 and id = $2`,
                [getOrgId(), nominationId]
            )
        })

        res.json({ success: true, message: 'Nomination approved and candidate added successfully!' })
    } catch (error) {
        console.error('Error approving nomination:', error)
        res.status(400).json({ message: error.message || 'Error processing approval.' })
    }
})

// --- Reject a nomination (keep it there, just change status to rejected) ---
router.post('/reject-nomination', async (req, res) => {
    const { nominationId } = req.body
    if (!nominationId) return res.status(400).json({ message: 'Nomination ID is required.' })

    try {
        const result = await query(
            `update nominations
             set status = 'rejected'
             where organization_id = $1 and id = $2 and status = 'pending'
             returning id`,
            [getOrgId(), nominationId]
        )

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Nomination not found or already processed.' })
        }

        res.json({ success: true, message: 'Nomination rejected.' })
    } catch (error) {
        console.error('Error rejecting nomination:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

// --- Reset election (delete all votes) ---
router.post('/reset-election', async (req, res) => {
    try {
        const result = await transaction(async client => {
            const deleted = await client.query(
                `delete from votes where organization_id = $1`,
                [getOrgId()]
            )
            return deleted
        })
        invalidateElectionCache()
        console.log(`[AUDIT] Election reset. Deleted ${result.rowCount} vote records.`)
        res.json({ success: true, message: `Election reset. Deleted ${result.rowCount} vote records.` })
    } catch (error) {
        console.error('Error resetting election:', error)
        res.status(500).json({ message: 'A server error occurred while resetting the election.' })
    }
})

// --- Export nominations (paginated, POST instead of GET with query param) ---
router.post('/export-nominations', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.body.page) || 1)
        const limit = Math.min(200, Math.max(1, parseInt(req.body.limit) || 100))
        const skip = (page - 1) * limit

        const [nominations, total] = await Promise.all([
            query(
                `select full_name as "fullName", popular_name as "popularName", position_id as category, image_url as "imageUrl"
                 from nominations
                 where organization_id = $1 and image_url is not null
                 order by submitted_at desc
                 offset $2 limit $3`,
                [getOrgId(), skip, limit]
            ),
            query(
                `select count(*)::int as count
                 from nominations
                 where organization_id = $1 and image_url is not null`,
                [getOrgId()]
            )
        ])
        const count = total.rows[0]?.count || 0
        res.json({ nominations: nominations.rows, total: count, page, totalPages: Math.ceil(count / limit) })
    } catch (error) {
        console.error('Error exporting nominations:', error)
        res.status(500).json({ message: 'A server error occurred during export.' })
    }
})

router.get('/setup', async (req, res) => {
    try {
        const orgId = getOrgId()
        const [electionRes, departmentsRes, positionsRes, candidatesRes] = await Promise.all([
            query(
                `select id, title, year, status
                 from elections
                 where organization_id = $1
                 order by created_at desc
                 limit 1`,
                [orgId]
            ),
            query(
                `select id, title, sort_order as "sortOrder"
                 from departments
                 where organization_id = $1
                 order by sort_order, title`,
                [orgId]
            ),
            query(
                `select id, title, group_key as "groupKey", department_id as "departmentId", sort_order as "sortOrder"
                 from positions
                 where organization_id = $1
                 order by sort_order, title`,
                [orgId]
            ),
            query(
                `select id, position_id as "positionId", name, description, image_url as "imageUrl", status
                 from candidates
                 where organization_id = $1
                 order by name`,
                [orgId]
            ),
        ])

        res.json({
            election: electionRes.rows[0] || null,
            departments: departmentsRes.rows,
            positions: positionsRes.rows,
            candidates: candidatesRes.rows,
        })
    } catch (error) {
        console.error('Error fetching setup data:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.put('/election', async (req, res) => {
    const { title, year, status } = req.body
    if (!title || !year || !['open', 'closed'].includes(status)) {
        return res.status(400).json({ message: 'Invalid election data.' })
    }

    try {
        const result = await query(
            `update elections
             set title = $2, year = $3, status = $4
             where id = (
                select id from elections where organization_id = $1 order by created_at desc limit 1
             )
             returning id, title, year, status`,
            [getOrgId(), title.trim(), String(year).trim(), status]
        )
        await query(
            `insert into settings (organization_id, key, value)
             values ($1, 'electionStatus', $2)
             on conflict (organization_id, key) do update
             set value = excluded.value, updated_at = now()`,
            [getOrgId(), status]
        )
        invalidateElectionCache()
        res.json(result.rows[0])
    } catch (error) {
        console.error('Error updating election:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.post('/departments', async (req, res) => {
    const { id, title, sortOrder } = req.body
    if (!id || !title) return res.status(400).json({ message: 'Department ID and title are required.' })

    try {
        const result = await query(
            `insert into departments (id, organization_id, title, sort_order)
             values ($1, $2, $3, $4)
             on conflict (id) do update
             set title = excluded.title, sort_order = excluded.sort_order
             returning id, title, sort_order as "sortOrder"`,
            [id.trim(), getOrgId(), title.trim(), Number(sortOrder) || 0]
        )
        res.status(201).json(result.rows[0])
    } catch (error) {
        console.error('Error saving department:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.delete('/departments/:id', async (req, res) => {
    try {
        const result = await query(
            `delete from departments where organization_id = $1 and id = $2`,
            [getOrgId(), req.params.id]
        )
        res.json({ success: true, deleted: result.rowCount })
    } catch (error) {
        console.error('Error deleting department:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.post('/positions', async (req, res) => {
    const { id, title, groupKey, departmentId, sortOrder } = req.body
    if (!id || !title || !['undergraduate', 'general', 'finalist', 'departmental'].includes(groupKey)) {
        return res.status(400).json({ message: 'Invalid position data.' })
    }

    try {
        const election = await query(
            `select id from elections where organization_id = $1 order by created_at desc limit 1`,
            [getOrgId()]
        )
        const electionId = election.rows[0]?.id
        if (!electionId) return res.status(400).json({ message: 'Create an election before adding positions.' })

        const result = await query(
            `insert into positions (id, organization_id, election_id, title, group_key, department_id, sort_order)
             values ($1, $2, $3, $4, $5, $6, $7)
             on conflict (id) do update
             set title = excluded.title,
                 group_key = excluded.group_key,
                 department_id = excluded.department_id,
                 sort_order = excluded.sort_order
             returning id, title, group_key as "groupKey", department_id as "departmentId", sort_order as "sortOrder"`,
            [id.trim(), getOrgId(), electionId, title.trim(), groupKey, departmentId || null, Number(sortOrder) || 0]
        )
        res.status(201).json(result.rows[0])
    } catch (error) {
        console.error('Error saving position:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.delete('/positions/:id', async (req, res) => {
    try {
        const result = await query(
            `delete from positions where organization_id = $1 and id = $2`,
            [getOrgId(), req.params.id]
        )
        res.json({ success: true, deleted: result.rowCount })
    } catch (error) {
        console.error('Error deleting position:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.post('/candidates', async (req, res) => {
    const { positionId, name, description, imageUrl, status } = req.body
    if (!positionId || !name) return res.status(400).json({ message: 'Position and candidate name are required.' })

    try {
        const election = await query(
            `select id from elections where organization_id = $1 order by created_at desc limit 1`,
            [getOrgId()]
        )
        const electionId = election.rows[0]?.id
        if (!electionId) return res.status(400).json({ message: 'Create an election before adding candidates.' })

        const result = await query(
            `insert into candidates (organization_id, election_id, position_id, name, description, image_url, status)
             values ($1, $2, $3, $4, $5, $6, $7)
             on conflict (election_id, position_id, lower(name)) do update
             set description = excluded.description,
                 image_url = excluded.image_url,
                 status = excluded.status
             returning id, position_id as "positionId", name, description, image_url as "imageUrl", status`,
            [
                getOrgId(),
                electionId,
                positionId,
                name.trim(),
                description || null,
                imageUrl || null,
                status || 'approved',
            ]
        )
        res.status(201).json(result.rows[0])
    } catch (error) {
        console.error('Error saving candidate:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

router.delete('/candidates/:id', async (req, res) => {
    try {
        const result = await query(
            `update candidates
             set status = 'rejected'
             where organization_id = $1 and id = $2
             returning id`,
            [getOrgId(), req.params.id]
        )
        res.json({ success: true, rejected: result.rowCount })
    } catch (error) {
        console.error('Error removing candidate:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

module.exports = router
