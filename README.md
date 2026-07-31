# Voting Portal Backend Template

Node/Express backend template for generated voting portal deployments.

## Database

This template uses Postgres. Apply `db/schema.sql` to the target database before deployment.

Required environment variables:

```bash
ORG_ID=pessa
ORG_NAME="PESSA Voting Portal"
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/pessa_voting
FRONTEND_ORIGIN=http://localhost:5173
ADMIN_PASSWORD=replace-this
JWT_SECRET=replace-this-too
PORT=4000
```

Use `FRONTEND_ORIGINS` with comma-separated origins when one backend needs to allow multiple frontend domains.

## Data Model

Election data belongs in Postgres:

- organizations
- elections
- departments
- positions
- candidates
- nominations
- votes
- settings

The frontend should not ship nominee data in static JSON files.
