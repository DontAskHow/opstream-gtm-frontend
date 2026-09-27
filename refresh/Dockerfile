# GTM refresh image: Python 3, Node 22, esbuild.
# Build from the repository root:
#   docker build -f refresh/Dockerfile -t opstream-gtm-refresh .
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && pip3 install --break-system-packages boto3 google-auth \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "refresh/run.py"]
