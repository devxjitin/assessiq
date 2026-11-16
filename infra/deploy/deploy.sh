#!/bin/bash
# Runs ON the EC2 host (invoked by GitHub Actions through SSM Run Command).
# Required environment: ENVIRONMENT, AWS_REGION, FILES_BUCKET, ECR_REGISTRY, IMAGE_TAG, API_HOST, WEB_ORIGIN
set -euo pipefail

APP_DIR=/opt/assessiq
cd "$APP_DIR"

: "${ENVIRONMENT:?}" "${AWS_REGION:?}" "${FILES_BUCKET:?}" "${ECR_REGISTRY:?}" "${IMAGE_TAG:?}" "${API_HOST:?}" "${WEB_ORIGIN:?}"

# Compose variables
cat > .deploy.env <<EOF
ECR_REGISTRY=${ECR_REGISTRY}
IMAGE_TAG=${IMAGE_TAG}
API_HOST=${API_HOST}
ENVIRONMENT=${ENVIRONMENT}
EOF

# App runtime config: fixed values + secrets from SSM Parameter Store (/assessiq/<env>/NAME)
{
  echo "NODE_ENV=production"
  echo "PORT=4000"
  echo "REDIS_URL=redis://redis:6379"
  echo "WEB_ORIGIN=${WEB_ORIGIN}"
  echo "AWS_REGION=${AWS_REGION}"
  echo "S3_BUCKET=${FILES_BUCKET}"
  aws ssm get-parameters-by-path --region "$AWS_REGION" --path "/assessiq/${ENVIRONMENT}/" \
    --with-decryption --query 'Parameters[].[Name,Value]' --output text |
    while IFS=$'\t' read -r name value; do
      echo "${name##*/}=${value}"
    done
} > .env
chmod 600 .env .deploy.env

aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$ECR_REGISTRY"

docker compose --env-file .deploy.env pull
docker compose --env-file .deploy.env up -d --remove-orphans

# Health check: the API must answer within ~60s, otherwise fail the deploy.
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4000/health >/dev/null; then
    echo "Deploy OK: ${IMAGE_TAG}"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 3
done

echo "Health check failed" >&2
docker compose --env-file .deploy.env logs --tail=50 api >&2 || true
exit 1
