# YouTube API Service

A TypeScript-based microservice for fetching YouTube Watch Later videos and transcripts.

## Features

- OAuth2 authentication with YouTube Data API v3
- Fetch all videos from Watch Later playlist
- Get transcripts for individual or multiple videos
- Basic authentication for API endpoints
- Token persistence across container restarts
- Health check endpoint

## Prerequisites

**Google Cloud Project with YouTube Data API v3 enabled**
- Go to: https://console.cloud.google.com/
- Create a new project or select an existing one
- Enable YouTube Data API v3
- Create OAuth 2.0 credentials (Desktop app type)
- Download credentials and note the Client ID and Client Secret

**Note on OAuth verification:** You don't need to verify your app if you're the only user. When authorizing, Google will show "This app isn't verified" - just click "Advanced" → "Go to [your app name] (unsafe)" → Authorize. This is safe since you built the app and are authorizing your own data.

## Setup

### 1. Configure Environment Variables

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:
```env
YOUTUBE_CLIENT_ID=your-client-id.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=your-client-secret
BASIC_AUTH_USER=your-username
BASIC_AUTH_PASS=your-password
BASE_DOMAIN=yourdomain.com
PORT=3000
```

### 2. Build the Docker Image

```bash
docker build -t youtube-api-service:latest .
```

### 3. Authorize the Application

The service needs one-time OAuth authorization:

1. **Start the service** (or access your deployed instance)

2. **Get the authorization URL:**
   ```bash
   curl https://youtube-api.yourdomain.com/auth/url
   ```

3. **Visit the URL** in your browser and authorize the application
   - Click through the "unverified app" warning (it's your own app)
   - Grant permissions
   - Copy the authorization code from the browser

4. **Submit the code** to complete authorization:
   ```bash
   curl -X POST https://youtube-api.yourdomain.com/auth/callback \
     -H "Content-Type: application/json" \
     -d '{"code": "YOUR_AUTHORIZATION_CODE"}'
   ```

The OAuth tokens will be saved in `/data/tokens.json` and persist across container restarts.

## API Endpoints

### Health Check
```bash
GET /health
```
No authentication required. Returns service status and authorization state.

**Response:**
```json
{
  "status": "ok",
  "authorized": true,
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### Get Authorization URL
```bash
GET /auth/url
```
Returns the OAuth authorization URL for first-time setup.

**Response:**
```json
{
  "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "instructions": "Visit this URL to authorize the application, then use the code with POST /auth/callback"
}
```

### Complete Authorization
```bash
POST /auth/callback
Content-Type: application/json

{
  "code": "authorization_code_from_google"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Authorization successful"
}
```

### Fetch Watch Later Videos
```bash
GET /videos
Authorization: Basic base64(username:password)
```

Returns all videos from your Watch Later playlist with metadata.

**Response:**
```json
{
  "count": 623,
  "videos": [
    {
      "videoId": "dQw4w9WgXcQ",
      "title": "Video Title",
      "channel": "Channel Name",
      "channelId": "UC...",
      "description": "Video description...",
      "duration": "PT15M30S",
      "publishedAt": "2023-01-01T00:00:00Z",
      "thumbnails": {
        "default": "https://...",
        "medium": "https://...",
        "high": "https://..."
      }
    }
  ],
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

**Duration format:** ISO 8601 (e.g., "PT15M30S" = 15 minutes 30 seconds)

### Get Single Transcript
```bash
GET /transcript/:videoId
Authorization: Basic base64(username:password)
```

Returns the transcript for a specific video.

**Response:**
```json
{
  "videoId": "dQw4w9WgXcQ",
  "transcript": [
    {
      "text": "Hello everyone",
      "duration": 2.5,
      "offset": 0
    },
    {
      "text": "Welcome to this video",
      "duration": 3.0,
      "offset": 2.5
    }
  ],
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

**Note:** Transcripts may not be available for all videos (depends on whether subtitles exist).

### Get Batch Transcripts
```bash
POST /batch-transcripts
Authorization: Basic base64(username:password)
Content-Type: application/json

{
  "videoIds": ["dQw4w9WgXcQ", "jNQXAC9IVRw"]
}
```

Returns transcripts for multiple videos. If a transcript fails to fetch, it will be `null`.

**Response:**
```json
{
  "transcripts": {
    "dQw4w9WgXcQ": [
      {
        "text": "Hello everyone",
        "duration": 2.5,
        "offset": 0
      }
    ],
    "jNQXAC9IVRw": null
  },
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

## Usage with n8n

### Example: Fetch Videos Workflow

1. **HTTP Request Node**
   - Method: GET
   - URL: `https://youtube-api.yourdomain.com/videos`
   - Authentication: Basic Auth
   - Credentials: Use your BASIC_AUTH_USER and BASIC_AUTH_PASS

2. **Process Videos**
   - The response will contain all your Watch Later videos
   - Use n8n's built-in functions to filter, transform, or store the data

### Example: Get Transcripts Workflow

1. **HTTP Request Node** - Fetch videos
2. **Function Node** - Extract video IDs (limit to batches of 10-20 to avoid timeouts)
3. **HTTP Request Node**
   - Method: POST
   - URL: `https://youtube-api.yourdomain.com/batch-transcripts`
   - Authentication: Basic Auth
   - Body: `{ "videoIds": [{{ $json.videoIds }}] }`
4. **Process transcripts** - Send to LLM for summarization, store in DB, create notes, etc.

### Example: Complete Processing Pipeline

```
[Schedule Trigger - Daily]
    ↓
[HTTP: Fetch Videos]
    ↓
[Filter: New videos only]
    ↓
[HTTP: Get Transcripts (batch)]
    ↓
[LLM: Summarize & Categorize]
    ↓
[Store in Database]
    ↓
[Create Notes]
```

## Development

### Local Development

```bash
npm install
npm run dev
```

The service will start on `http://localhost:3000`

### Build

```bash
npm run build
```

### Docker Build

```bash
docker build -t youtube-api-service:latest .
```

## Troubleshooting

### Token Issues
If authorization fails or tokens become invalid:
1. Delete the token file (in your volume or `/data/tokens.json`)
2. Restart the service
3. Re-run the authorization flow (`/auth/url` → `/auth/callback`)

### Transcript Not Available
Some videos don't have transcripts available. This happens when:
- The video has no captions/subtitles
- Captions are disabled by the uploader
- The video is very new and auto-captions haven't been generated yet

The `/batch-transcripts` endpoint handles this gracefully by returning `null` for failed videos.

### YouTube API Quotas
YouTube Data API v3 has daily quota limits. If you hit the quota:
- Wait until the quota resets (midnight Pacific Time)
- Reduce the frequency of your n8n workflows
- Consider caching video lists and only fetching new videos

## Notes

- OAuth tokens are stored in `/data/tokens.json` inside the container
- Tokens automatically refresh when they expire
- YouTube API has quotas - be mindful of rate limits when scheduling workflows
- Transcripts may not be available for all videos
- Duration format is ISO 8601 (e.g., "PT15M30S" = 15 minutes 30 seconds)

## License

MIT