# TypeScript on Rails application

This is a neutral full-stack starting point. It includes one registered status feature, one operation-backed HTTP route, one server-rendered page, and one small client interaction.

```bash
npm install
npm run check
npm run dev
```

Open `http://localhost:3420` or request `GET /api/status`.

Add product features with `app create feature`. Add PostgreSQL, durable jobs, identity, and external adapters only when the application needs them. The generated app performs no production network or database work by default.
