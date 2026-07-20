# no.social

A minimal serverless ActivityPub publisher built with Deno.

## Overview

no.social is a lightweight ActivityPub server that lets you publish notes to followers on the federated social web. It provides a simple web interface for managing content and supports basic ActivityPub protocol interactions.

## Features

- 📝 **Publish Notes** - Create and share text notes with followers
- 👥 **Follower Interactions** - Handle follow and unfollow requests, and deliver notes to followers' inboxes
- 🔑 **Cryptographic Keys** - Automatic RSA key pair generation and management
- 🌐 **ActivityPub Federation** - ActivityPub protocol support via Fedify for discovery, follow/unfollow, inbox delivery, and delete activities
- 💾 **Persistent Storage** - Deno KV database for notes, activities, and followers
- 🎨 **Web Interface** - Simple HTML dashboard for content management

## Environment Variables

Configure the following environment variables:

- `AP_USERNAME` - Your ActivityPub username (default: `"me"`)
- `AP_DISPLAY_NAME` - Display name shown on your profile (default: `"me"`)
- `AP_SUMMARY` - Profile bio/summary text
- `AP_AVATAR_URL` - Avatar image URL
- `AP_API_TOKEN` - Token required for publishing notes and deleting content

## Getting Started

### Prerequisites

- [Deno](https://deno.land) v1.40 or later

### Installation

```bash
deno run -A --env-file server.ts
```

The server will start on `http://localhost:8000`

## API Endpoints

### Public Endpoints

- `GET /` - Web interface and profile page
- `GET /users/{username}` - Actor profile (ActivityPub)
- `GET /users/{username}/outbox` - User's activities
- `GET /users/{username}/followers` - List of followers
- `GET /notes/{id}` - Individual note

### Protected Endpoints (require `AP_API_TOKEN`)

- `POST /notes` - Create a new note
  - JSON: `{ "content": "Note text" }`
  - Form: `content=Note text`
  
- `DELETE /notes/{id}` - Delete a note (broadcasts Delete activity)

- `GET /clear-kv` - Clear all data (use with caution)

## Deployment

This project is configured for [Deno Deploy](https://deno.com/deploy):

```bash
deno deploy --project no-social
```

Update the deployment configuration in `deno.json` as needed.

## Technologies

- [Deno](https://deno.land) - JavaScript/TypeScript runtime
- [Fedify](https://jsr.io/@fedify/fedify) - ActivityPub framework
- [Deno KV](https://deno.com/kv) - Key-value database
- [LogTape](https://jsr.io/@logtape/logtape) - Logging library

## License

MIT
