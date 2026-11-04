# AI Storyboard Service Contract

The static GitHub Pages frontend intentionally does not contain provider secrets. Configure a private HTTPS backend endpoint in the AI Storyboard workspace. The browser sends all selected video files as multipart form data.

## Request

POST multipart/form-data:
- `prompt`: user editing instruction
- `targetDuration`: requested final duration in seconds
- `platform`: target publishing platform
- `style`: editing style
- `assets`: JSON array of `{ id, name, duration, mimeType }`
- repeated `videos`: original video files, in the same order as assets

The backend is responsible for:
1. Validate file count, size, MIME types, duration and user authorization.
2. Analyze the video and its available audio with a multimodal model.
3. Identify useful segments (speech relevance, shot quality, duplicates, pauses and visual clarity) and summarize spoken content where available.
4. Plan a coherent narrative: hook, key points, supporting visuals and closing.
5. Return source time ranges and script lines. Never fabricate property facts; mark unknown details for user confirmation.

## Response

Return JSON:
```json
{
  "scenes": [
    {
      "assetId": "frontend-asset-id",
      "sourceStart": 2.4,
      "sourceEnd": 7.8,
      "title": "開場：空間亮點",
      "voiceover": "以一句有吸引力的開場帶出主要特色。",
      "visualNote": "保留鏡頭穩定、光線良好的客廳畫面。"
    }
  ]
}
```

The frontend validates the returned asset IDs and source time ranges, allows manual edits and applies the ordered scenes to V1. The response may also include `warnings` for missing audio, low confidence or facts that require confirmation.

## Security and operational requirements

- Keep provider API keys only in backend environment secrets; never embed them in the frontend or GitHub Pages bundle.
- Require authentication/rate limits and enforce upload limits.
- Use temporary storage and delete uploaded media after processing.
- Return CORS headers for the deployed Pages origin.
- Do not train on or retain customer media unless the user explicitly consents.
- Provide progress/status endpoints for long uploads and analysis jobs in a production implementation.
- The current frontend uses a job-based API: upload returns HTTP 202 and a job ID, then the browser polls the authenticated status endpoint until completion.

## Current implementation boundary

The frontend workspace, background-job polling adapter and Cloudflare Worker source are implemented. GitHub Pages hosts only the frontend; it does not deploy the AI backend. Until the Worker is deployed and its Gemini secrets are configured, the UI must not claim that visual understanding, speech analysis or automatic highlight selection has occurred.

## Included Cloudflare Worker

A Gemini-powered Worker implementation is included at `worker/src/index.ts`.

Deploy it from the `worker` directory with Wrangler:
1. Install Wrangler and authenticate with your Cloudflare account.
2. Create the R2 bucket and deploy the Worker once (the GitHub Actions workflow can do both).
3. After the first deployment creates the Worker script, add `GEMINI_API_KEY` and `APP_TOKEN` as Worker secrets using `npx wrangler secret put GEMINI_API_KEY` and `npx wrangler secret put APP_TOKEN` from the `worker` directory, or add them in the Cloudflare dashboard.
4. Run the Worker deployment workflow again if you changed bindings or code. Secret changes take effect without putting the values in the repository.
5. Paste the resulting `workers.dev` URL and the same APP_TOKEN into the AI Storyboard panel.

The current implementation accepts up to 12 video files, with a 12 MB per-file and 45 MB combined upload limit. The browser uploads the files to temporary R2 storage, creates a Durable Object-backed background job, and receives a job ID immediately. The Worker analyzes each video sequentially, records progress, generates a combined storyboard, and removes temporary R2 media after completion. The frontend polls the job endpoint and loads the finished storyboard. This removes the long Gemini analysis from the original upload request, but the initial browser-to-Worker upload is still a single request; resumable/chunked uploads and Gemini Files API support remain future work. Cloudflare Worker deployment, an R2 bucket, Durable Objects and Gemini credentials are external prerequisites; GitHub Pages cannot host private API secrets.

## Deploy with GitHub Actions

1. In Cloudflare, create an API token with **Workers Scripts: Edit** and the required account access.
2. In this GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
3. Run **Actions → Deploy AI Storyboard Worker → Run workflow** once. This first deployment creates the Worker script and binds the R2 bucket / Durable Object class. The deployment log prints the Worker URL (usually `https://ai-video-studio-storyboard.<subdomain>.workers.dev`).
4. After the Worker exists, add secrets from the repository's `worker` directory with Wrangler:
   - `npx wrangler secret put GEMINI_API_KEY`
   - `npx wrangler secret put APP_TOKEN`
   Use a long random APP_TOKEN. Never commit either value. You can also add these in the Cloudflare dashboard under the Worker settings.
5. Open `https://<your-worker>.workers.dev/health` and confirm `ready: true`. Then open the deployed editor, open AI 腳本與分鏡, paste the Worker URL and the same APP_TOKEN into the two fields.

The Worker performs each video's analysis in its own Durable Object alarm step, then runs one combined edit-plan request in a final step. Each step persists progress before scheduling the next alarm, independent of the browser upload request. It is deliberately capped at 12 clips / 12 MB each / 45 MB total. Each job exposes `GET /jobs/{jobId}` for status and progress; the same Bearer APP_TOKEN is required. Temporary source videos are stored in R2 and deleted when processing ends. Job status records are retained for up to 24 hours and then automatically removed. The API returns only public job status fields, not internal R2 object keys. It does not yet provide resumable/chunked uploads, cancellation, or user-facing job history. Gemini API charges still apply, and long individual video analysis may be subject to provider limits.

## Health check

After deploying, open `https://<your-worker>.workers.dev/health` in a browser. A successful response includes `ok: true`; `ready: true` means both Worker secrets and the R2 / Durable Objects bindings are available. The health endpoint is public for deployment diagnostics and can be opened directly without an Origin header. All upload and job-status routes still require the allowed Pages origin and Bearer APP_TOKEN. The editor also includes **測試 AI 後端連線** beside the endpoint settings. This check verifies Worker reachability and configuration presence; it does not spend Gemini credits or run a video analysis.


## Background job API (Worker v2)

- `POST /`: authenticated multipart upload; returns HTTP 202 with `{ jobId, status: "queued" }`.
- `GET /jobs/{jobId}`: authenticated status polling. Status is `queued`, `processing`, `completed`, or `failed`. During processing, `progress`, `total`, `currentFile`, and `message` are returned. Completed jobs include `result.scenes`, `result.warnings`, and `result.overallScript`.
- Background execution uses a Durable Object alarm. Temporary media is stored in the `ai-video-studio-media` R2 bucket and deleted after success or failure.
- The deployment workflow attempts to create the R2 bucket before deployment. The Cloudflare account must permit R2 bucket creation and Durable Objects. If the bucket already exists, the create step is allowed to continue and deployment uses the existing bucket.
