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
- Create OAuth 2.0 credentials (**Web application** type, not Desktop)
- In "Authorized redirect URIs", add: `https://youtube-api.yourdomain.com/oauth/callback`
  (Replace `yourdomain.com` with your actual domain)
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
OAUTH_REDIRECT_URI=https://youtube-api.yourdomain.com/oauth/callback
BASIC_AUTH_USER=your-username
BASIC_AUTH_PASS=your-password
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

### OAuth Endpoints

**Get Authorization URL**
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

**Complete Authorization**
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

### List Your Playlists
```bash
GET /playlists
Authorization: Basic base64(username:password)
```

Returns all playlists in your YouTube channel.

**Response:**
```json
{
  "count": 15,
  "playlists": [
    {
      "id": "PLxxxxxxxxxxxxxxxxxxxxxx",
      "title": "My Playlist",
      "description": "Playlist description",
      "itemCount": 42,
      "publishedAt": "2025-11-29T14:24:16Z"
    },
    {
      "id": "PLyyyyyyyyyyyyyyyyyyyyyy",
      "title": "Another Playlist",
      "description": "",
      "itemCount": 28,
      "publishedAt": "2021-09-14T14:38:03Z"
    }
  ],
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### Fetch Specific Playlist
```bash
GET /playlist/:playlistId
Authorization: Basic base64(username:password)
```

Returns all videos from a specific playlist.

**Example:**
```bash
curl -u username:password https://youtube-api.yourdomain.com/playlist/PLxxxxxxxxxxxxxxxxxxxxxx
```

**Response:**
```json
{
  "playlistId": "PLxxxxxxxxxxxxxxxxxxxxxx",
  "count": 42,
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

### Fetch Videos (with optional playlist parameter)
```bash
GET /videos?playlistId=PLAYLIST_ID
Authorization: Basic base64(username:password)
```

Returns videos from the specified playlist. If no `playlistId` is provided, returns videos from your default playlist (configure in code).

**Example:**
```bash
curl -u username:password "https://youtube-api.yourdomain.com/videos?playlistId=PLxxxxxxxxxxxxxxxxxxxxxx"
```

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

## Important Notes

### Watch Later Limitation
**YouTube deprecated API access to Watch Later playlists in September 2016.** The special playlist ID 'WL' returns empty results for all users. This is a YouTube API limitation, not a bug in this service.

**Workarounds:**
1. Use the `/playlists` endpoint to list your available playlists
2. Use any of your public or private playlists
3. Create a dedicated playlist for videos you want to process

See: [YouTube API Revision History](https://developers.google.com/youtube/v3/revision_history#september-15-2016)

## Usage with n8n

### Example: List Available Playlists

1. **HTTP Request Node**
   - Method: GET
   - URL: `https://youtube-api.yourdomain.com/playlists`
   - Authentication: Basic Auth
   - Credentials: Use your BASIC_AUTH_USER and BASIC_AUTH_PASS

2. **Process Playlists**
   - The response contains all your playlists with their IDs
   - Use n8n's built-in functions to filter or select the playlist you want

### Example: Fetch Videos from Specific Playlist

1. **HTTP Request Node**
   - Method: GET
   - URL: `https://youtube-api.yourdomain.com/playlist/YOUR_PLAYLIST_ID`
   - Authentication: Basic Auth
   - Credentials: Use your BASIC_AUTH_USER and BASIC_AUTH_PASS

2. **Process Videos**
   - The response will contain all videos from that playlist
   - Use n8n's built-in functions to filter, transform, or store the data

### Example: Get Transcripts Workflow

1. **HTTP Request Node** - Fetch playlist videos
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
[HTTP: List Playlists]
    ↓
[Filter: Select target playlist]
    ↓
[HTTP: Fetch Videos from Playlist]
    ↓
[Filter: New videos only]
    ↓
[HTTP: Get Transcripts (batch)]
    ↓
[LLM: Summarize & Categorize]
    ↓
[Store in Database]
    ↓
[Create Obsidian/Evernote Notes]
```

### Tips for n8n Workflows

- Store your playlist IDs in n8n environment variables for easy reuse
- Use the `/playlists` endpoint once to discover your playlist IDs
- For large playlists (600+ videos), consider processing in batches
- Cache video data to avoid re-fetching unchanged playlists

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