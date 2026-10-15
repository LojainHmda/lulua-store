# Neon sync

One-way copy of the store's Firestore database (`lulua-store` in project
`kartacagenai`) into Neon PostgreSQL, for reports, Excel/BI tools and backups.
The app itself keeps using Firestore; nothing here writes back.

- Runs as the Cloud Run Job `lulua-neon-sync` (europe-west2), triggered every
  10 minutes by Cloud Scheduler job `lulua-neon-sync-every-10min`.
- The Neon connection string lives only in Secret Manager
  (`lulua-neon-database-url`), injected as `DATABASE_URL`.
- Each Firestore collection becomes `lulua.<collection_in_snake_case>`
  (`id`, `data jsonb`, `synced_at`), fully refreshed in one transaction per run.
  `posLinks` is skipped (its ids are POS access tokens).

## Views

| View | One row per |
|---|---|
| `lulua.v_orders` | order (web, POS, manual) with totals, branch, cashier, payment |
| `lulua.v_order_lines` | order line (product, color, size, qty, price) |
| `lulua.v_products` | product |
| `lulua.v_branch_stock` | branch × product × color × size count |
| `lulua.v_stock_movements` | stock ledger entry |

Example: sales per branch today

```sql
SELECT branch_name, count(*) AS orders, sum(total) AS revenue
FROM lulua.v_orders
WHERE created_at >= date_trunc('day', now()) AND status <> 'cancelled'
GROUP BY 1 ORDER BY revenue DESC;
```

## Deploy / run

```sh
gcloud run jobs deploy lulua-neon-sync --source . --region europe-west2 --project kartacagenai \
  --set-secrets DATABASE_URL=lulua-neon-database-url:latest --set-env-vars FIRESTORE_DATABASE=lulua-store
gcloud run jobs execute lulua-neon-sync --region europe-west2 --project kartacagenai --wait
```

New Neon password: `gcloud secrets versions add lulua-neon-database-url --data-file=<file>`.
