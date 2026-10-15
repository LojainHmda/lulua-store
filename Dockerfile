# Cloud Run image: serves the prebuilt app (`npm run build` -> dist/) with
# nginx. Build first with the production Firebase config in
# .env.production.local, then `gcloud run deploy --source .` (see
# .gcloudignore: only dist/ and these files are uploaded).
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist /usr/share/nginx/html
EXPOSE 8080
