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
2. Extract audio and representative frames from every video.
3. Transcribe speech with timestamps.
4. Analyze visual content and score useful segments (speech relevance, shot quality, duplicates, pauses and blur).
5. Plan a coherent narrative: hook, key points, supporting visuals and closing.
6. Return source time ranges and script lines. Never fabricate property facts; mark unknown details for user confirmation.

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
- The current frontend expects a synchronous JSON response. For long videos, implement a job-based API (202 accepted + job ID + polling) before production use.

## Current implementation boundary

The frontend workspace and synchronous multipart adapter are implemented. An actual AI backend/provider is not deployed by GitHub Pages. Until a private backend is configured, the UI must not claim that visual understanding, transcription or automatic highlight selection has occurred.

## Included Cloudflare Worker

A Gemini-powered Worker implementation is included at `worker/src/index.ts`.

Deploy it from the `worker` directory with Wrangler:
1. Install Wrangler and authenticate with your Cloudflare account.
2. Set secrets: `wrangler secret put GEMINI_API_KEY` and `wrangler secret put APP_TOKEN`.
3. Run `wrangler deploy`.
4. Paste the resulting `workers.dev` URL and the same APP_TOKEN into the AI Storyboard panel.

The included first implementation accepts up to 12 video files, with a 15 MB per-file inline limit. It analyzes each video separately, then generates a combined storyboard. Larger files need a future resumable upload / Gemini Files API implementation. Cloudflare Worker deployment and Gemini credentials are external prerequisites; GitHub Pages cannot host private API secrets.
