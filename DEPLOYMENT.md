# Citadelle Web-Agent — Google Cloud Run Deployment

## Prerequisites

- Google Cloud SDK (`gcloud`) installed and authenticated
- A GCP project with billing enabled
- Cloud Build API and Cloud Run API enabled

## Quick Start

### 1. Set your GCP project

```bash
export PROJECT_ID=your-gcp-project-id
gcloud config set project $PROJECT_ID
```

### 2. Enable required APIs

```bash
gcloud services enable cloudbuild.googleapis.com run.googleapis.com containerregistry.googleapis.com
```

### 3. Set environment variables

```bash
gcloud run services update citadelle-web-agent \
  --region us-central1 \
  --set-env-vars "AI_INTEGRATIONS_GEMINI_API_KEY=your-gemini-api-key,AI_INTEGRATIONS_GEMINI_BASE_URL=https://generativelanguage.googleapis.com"
```

## Deployment Options

### Option A: Automated via Cloud Build (Recommended — Hackathon Bonus Points)

Submit the build using the `cloudbuild.yaml` Infrastructure-as-Code file:

```bash
gcloud builds submit --config cloudbuild.yaml --project $PROJECT_ID
```

This single command will:
1. Build the Docker image using the Playwright base image
2. Push the image to Google Container Registry
3. Deploy to Cloud Run with 2 vCPU, 2GB RAM, WebSocket support

### Option B: Manual Docker Build + Deploy

```bash
# Build the container image
gcloud builds submit --tag gcr.io/$PROJECT_ID/citadelle-web-agent

# Deploy to Cloud Run
gcloud run deploy citadelle-web-agent \
  --image gcr.io/$PROJECT_ID/citadelle-web-agent \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300s \
  --concurrency 10 \
  --session-affinity \
  --set-env-vars "NODE_ENV=production,PORT=8080"
```

### Option C: Local Docker Test

```bash
# Build locally
docker build -t citadelle-web-agent .

# Run locally
docker run -p 8080:8080 \
  -e NODE_ENV=production \
  -e PORT=8080 \
  -e AI_INTEGRATIONS_GEMINI_API_KEY=your-key \
  -e AI_INTEGRATIONS_GEMINI_BASE_URL=https://generativelanguage.googleapis.com \
  citadelle-web-agent
```

## Architecture Notes

- **Base Image**: `mcr.microsoft.com/playwright:v1.52.0-noble` — includes all system dependencies for headless Chromium
- **Port**: 8080 (Cloud Run default)
- **Memory**: 2GB minimum (Playwright + Chromium requires significant memory)
- **CPU**: 2 vCPU (for concurrent browser automation + screenshot streaming)
- **Session Affinity**: Enabled for WebSocket connection persistence
- **Timeout**: 300s per request (agent runs take 30-50 seconds)

## Verify Deployment

After deployment, Cloud Run will provide a URL like:

```
https://citadelle-web-agent-XXXXXX-uc.a.run.app
```

Visit the URL to confirm the app is running. Enter a search query and click "Run Agent" to verify the full Playwright + Gemini pipeline works in the cloud.
